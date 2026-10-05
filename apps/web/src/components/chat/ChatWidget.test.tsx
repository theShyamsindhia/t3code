// @vitest-environment jsdom
import { act } from "react";
import * as NodeVM from "node:vm";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ChatWidget } from "./ChatWidget";
import { chatWidgetDocument } from "./chatWidgetDocument";

const widget = {
  title: "Interruption balance",
  description: "Try a different level",
  html: "<input aria-label='Level' type='range'>",
  height: 200,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button, [role=menuitem]"),
  ).find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function message(
  data: unknown,
  source: MessageEventSource | null = container.querySelector("iframe")!.contentWindow,
) {
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source, data })));
}
const submit = () => vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);

it("stages a reply only from its own frame and never auto-sends it", async () => {
  const onSubmit = submit();
  await act(async () =>
    root.render(<ChatWidget widget={widget} storageKey="one" theme="light" onSubmit={onSubmit} />),
  );
  await message({ type: "t3-widget-response", text: "spoofed" }, window);
  await message({ type: "t3-widget-response", text: "x".repeat(4001) });
  await message({ type: "send", text: "unsupported" });
  expect(container.querySelector("textarea")).toBeNull();
  const document = container.querySelector("iframe")!.srcdoc;
  await message({ type: "t3-widget-response", text: "Suggest only when I'm stuck." });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).toContain("Suggest only when I'm stuck.");
  await click("Edit reply");
  expect(container.querySelector("textarea")?.value).toBe("Suggest only when I'm stuck.");
  await click("Done editing");
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector("iframe")!.srcdoc).toBe(document);
  await click("Send reply");
  expect(onSubmit).toHaveBeenCalledWith(
    "My response to “Interruption balance”:\n\nSuggest only when I'm stuck.",
  );
  expect(container.textContent).toContain("Sent to this chat.");
  expect(container.textContent).not.toContain("Send reply");
});

it("keeps failed replies, survives remounts, isolates threads, and closes running frames", async () => {
  const onSubmit = submit().mockResolvedValueOnce(false);
  const render = async (key: string) =>
    act(async () =>
      root.render(
        <ChatWidget key={key} widget={widget} storageKey={key} theme="dark" onSubmit={onSubmit} />,
      ),
    );
  await render("one");
  await message({ type: "t3-widget-response", text: "Keep it quiet" });
  await click("Send reply");
  expect(container.textContent).toContain("Couldn’t send yet");
  await click("Widget options");
  await click("Close widget");
  expect(container.querySelector("iframe")).toBeNull();
  await render("two");
  expect(container.querySelector("textarea")).toBeNull();
  await render("one");
  expect(container.querySelector("iframe")).toBeNull();
  await click("Open widget");
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(container.textContent).toContain("Keep it quiet");
  await click("Send reply");
  await render("two");
  await render("one");
  expect(container.textContent).toContain("Sent to this chat.");
  expect(container.textContent).not.toContain("Send reply");
  await message({ type: "t3-widget-response", text: "But guide me when learning" });
  expect(button("Send reply").disabled).toBe(false);
});

it("keeps newer edits when an earlier reply finishes sending", async () => {
  let finish!: (sent: boolean) => void;
  const onSubmit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(<ChatWidget widget={widget} storageKey="one" theme="light" onSubmit={onSubmit} />),
  );
  await message({ type: "t3-widget-response", text: "first" });
  await click("Send reply");
  expect(button("Sending…").disabled).toBe(true);
  await message({ type: "t3-widget-response", text: "second" });
  await act(async () => finish(true));
  expect(container.textContent).toContain("second");
  expect(button("Send reply").disabled).toBe(false);
});

it("reveals instructions on demand and preserves a corrected reply when restarting", async () => {
  const onSubmit = submit();
  await act(async () =>
    root.render(<ChatWidget widget={widget} storageKey="one" theme="light" onSubmit={onSubmit} />),
  );
  expect(container.textContent).not.toContain(widget.description);
  expect(container.textContent).not.toContain("Send reply");
  await click("Widget options");
  await click("Instructions");
  expect(container.textContent).toContain(widget.description);
  await message({ type: "t3-widget-response", text: "Be proactive" });
  const frame = container.querySelector("iframe");
  await click("Edit reply");
  const textarea = container.querySelector("textarea")!;
  expect(document.activeElement).toBe(textarea);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Be proactive only when I ask",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Done editing");
  expect(container.textContent).toContain("Be proactive only when I ask");
  expect(container.querySelector("iframe")).toBe(frame);
  await click("Widget options");
  await click("Restart widget");
  expect(container.querySelector("iframe")).not.toBe(frame);
  expect(container.textContent).toContain("Be proactive only when I ask");
  expect(onSubmit).not.toHaveBeenCalled();
  await click("Send reply");
  expect(onSubmit.mock.calls[0]?.[0]).toContain("Be proactive only when I ask");
});

it("does not let markup escape into the trusted wrapper", () => {
  const hostile =
    '</script><iframe src="https://example.invalid/leak"></iframe><script>parent.postMessage("forged","*")</script>';
  const html = chatWidgetDocument({ ...widget, html: hostile }, "dark", hostile);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelectorAll("script")).toHaveLength(1);
  expect(parsed.querySelectorAll("iframe")).toHaveLength(0);
  expect(parsed.body.children).toHaveLength(1);
  expect(
    parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  ).toContain("frame-src 'none'");
});

it("runs the generated bridge and relays only bounded responses from the inner document", () => {
  const html = chatWidgetDocument(widget, "light", "Previous choice");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const frame = { contentWindow: {}, srcdoc: "" };
  const delivered = vi.fn();
  let receive = (_event: { source: object; data: unknown }) => {};
  new NodeVM.Script(parsed.querySelector("script")!.textContent!).runInNewContext({
    document: { createElement: () => frame, body: { append: vi.fn() } },
    window: {
      addEventListener: (_type: string, listener: typeof receive) => {
        receive = listener;
      },
    },
    parent: { postMessage: delivered },
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  const inner = new DOMParser().parseFromString(frame.srcdoc, "text/html");
  const interactions = new Map<string, (event: { isTrusted: boolean }) => void>();
  const widgetWindow: {
    t3?: { setResponse: (text: unknown) => void; initialResponse: string };
    addEventListener: (type: string, listener: (event: { isTrusted: boolean }) => void) => void;
  } = {
    addEventListener: (type, listener) => {
      interactions.set(type, listener);
    },
  };
  new NodeVM.Script(inner.querySelector("script")!.textContent!).runInNewContext({
    window: widgetWindow,
    parent: { postMessage: (data: unknown) => receive({ source: frame.contentWindow, data }) },
  });
  expect(widgetWindow.t3?.initialResponse).toBe("Previous choice");
  widgetWindow.t3!.setResponse("Initialization must not replace the saved reply");
  expect(delivered).not.toHaveBeenCalled();
  interactions.get("input")!({ isTrusted: false });
  widgetWindow.t3!.setResponse("Programmatic initialization is not a choice either");
  expect(delivered).not.toHaveBeenCalled();
  interactions.get("keydown")!({ isTrusted: true });
  widgetWindow.t3!.setResponse("More guidance please");
  expect(delivered).toHaveBeenCalledWith(
    { type: "t3-widget-response", text: "More guidance please" },
    "*",
  );
  widgetWindow.t3!.setResponse({ unexpected: true });
  widgetWindow.t3!.setResponse("x".repeat(4001));
  receive({ source: {}, data: { type: "t3-widget-response", text: "forged" } });
  expect(delivered).toHaveBeenCalledTimes(1);
});

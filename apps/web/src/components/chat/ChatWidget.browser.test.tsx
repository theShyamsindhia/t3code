import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ChatWidget } from "./ChatWidget";
import { chatWidgetDocument } from "./chatWidgetDocument";

const widget = {
  title: "Interruption balance",
  description: "Try a different level",
  html: "<input aria-label='Level' type='range'>",
  height: 200,
};

function freshStorage(): Disposable {
  localStorage.clear();
  return { [Symbol.dispose]: () => localStorage.clear() };
}
function button(text: string) {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button, [role=menuitem]"),
  ).find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
async function click(text: string) {
  await act(() => button(text).click());
}
async function message(container: HTMLElement, data: unknown, source?: MessageEventSource) {
  const frameSource = source ?? container.querySelector("iframe")!.contentWindow!;
  await act(() => window.dispatchEvent(new MessageEvent("message", { source: frameSource, data })));
}
const submit = () => vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);

it("stages a reply only from its own frame and never auto-sends it", async () => {
  using _storage = freshStorage();
  const onSubmit = submit();
  await using screen = await render(
    <ChatWidget widget={widget} storageKey="one" theme="light" onSubmit={onSubmit} />,
  );
  const { container } = screen;
  await message(container, { type: "t3-widget-response", text: "spoofed" }, window);
  await message(container, { type: "t3-widget-response", text: "x".repeat(4001) });
  await message(container, { type: "send", text: "unsupported" });
  expect(container.querySelector("textarea")).toBeNull();
  const srcdoc = container.querySelector("iframe")!.srcdoc;
  await message(container, { type: "t3-widget-response", text: "Suggest only when I'm stuck." });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).toContain("Suggest only when I'm stuck.");
  await click("Edit reply");
  expect(container.querySelector("textarea")?.value).toBe("Suggest only when I'm stuck.");
  await click("Done editing");
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector("iframe")!.srcdoc).toBe(srcdoc);
  await click("Send reply");
  expect(onSubmit).toHaveBeenCalledWith(
    "My response to “Interruption balance”:\n\nSuggest only when I'm stuck.",
  );
  expect(container.textContent).toContain("Sent to this chat.");
  expect(container.textContent).not.toContain("Send reply");
});

it("keeps failed replies, survives remounts, isolates threads, and closes running frames", async () => {
  using _storage = freshStorage();
  const onSubmit = submit().mockResolvedValueOnce(false);
  const widgetFor = (key: string) => (
    <ChatWidget key={key} widget={widget} storageKey={key} theme="dark" onSubmit={onSubmit} />
  );
  await using screen = await render(widgetFor("one"));
  const { container } = screen;
  await message(container, { type: "t3-widget-response", text: "Keep it quiet" });
  await click("Send reply");
  expect(container.textContent).toContain("Couldn’t send yet");
  await click("Widget options");
  await click("Close widget");
  expect(container.querySelector("iframe")).toBeNull();
  await screen.rerender(widgetFor("two"));
  expect(container.querySelector("textarea")).toBeNull();
  await screen.rerender(widgetFor("one"));
  expect(container.querySelector("iframe")).toBeNull();
  await click("Open widget");
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(container.textContent).toContain("Keep it quiet");
  await click("Send reply");
  await screen.rerender(widgetFor("two"));
  await screen.rerender(widgetFor("one"));
  expect(container.textContent).toContain("Sent to this chat.");
  expect(container.textContent).not.toContain("Send reply");
  await message(container, { type: "t3-widget-response", text: "But guide me when learning" });
  expect(button("Send reply").disabled).toBe(false);
});

it("keeps newer edits when an earlier reply finishes sending", async () => {
  using _storage = freshStorage();
  let finish!: (sent: boolean) => void;
  const onSubmit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await using screen = await render(
    <ChatWidget widget={widget} storageKey="one" theme="light" onSubmit={onSubmit} />,
  );
  const { container } = screen;
  await message(container, { type: "t3-widget-response", text: "first" });
  await click("Send reply");
  expect(button("Sending…").disabled).toBe(true);
  await message(container, { type: "t3-widget-response", text: "second" });
  await act(() => finish(true));
  expect(container.textContent).toContain("second");
  expect(button("Send reply").disabled).toBe(false);
});

it("reveals instructions on demand and preserves a corrected reply when restarting", async () => {
  using _storage = freshStorage();
  const onSubmit = submit();
  await using screen = await render(
    <ChatWidget widget={widget} storageKey="one" theme="light" onSubmit={onSubmit} />,
  );
  const { container } = screen;
  expect(container.textContent).not.toContain(widget.description);
  expect(container.textContent).not.toContain("Send reply");
  await click("Widget options");
  await click("Instructions");
  expect(container.textContent).toContain(widget.description);
  await message(container, { type: "t3-widget-response", text: "Be proactive" });
  const frame = container.querySelector("iframe");
  await click("Edit reply");
  const textarea = container.querySelector("textarea")!;
  expect(document.activeElement).toBe(textarea);
  await act(() => {
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

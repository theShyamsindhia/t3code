import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

import { chatWidgetDocument } from "./chatWidgetDocument";

const widget = {
  title: "Interruption balance",
  description: "Try a different level",
  html: "<input aria-label='Level' type='range'>",
  height: 200,
};

// An HTML parser ends a script at its first `</script`, as this does.
function firstScript(html: string): string {
  const match = /<script[^>]*>([\s\S]*?)<\/script/i.exec(html);
  if (!match) throw new Error("Missing script");
  return match[1]!;
}

it("runs the generated bridge and relays only bounded responses from the inner document", () => {
  const html = chatWidgetDocument(widget, "light", "Previous choice");
  const frame = { contentWindow: {}, srcdoc: "" };
  const delivered = vi.fn();
  let receive = (_event: { source: object; data: unknown }) => {};
  new NodeVM.Script(firstScript(html)).runInNewContext({
    document: { createElement: () => frame, body: { append: vi.fn() } },
    window: {
      addEventListener: (_type: string, listener: typeof receive) => {
        receive = listener;
      },
    },
    parent: { postMessage: delivered },
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  const interactions = new Map<string, (event: { isTrusted: boolean }) => void>();
  const widgetWindow: {
    t3?: { setResponse: (text: unknown) => void; initialResponse: string };
    addEventListener: (type: string, listener: (event: { isTrusted: boolean }) => void) => void;
  } = {
    addEventListener: (type, listener) => {
      interactions.set(type, listener);
    },
  };
  new NodeVM.Script(firstScript(frame.srcdoc)).runInNewContext({
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

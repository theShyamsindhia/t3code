// @vitest-environment jsdom
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { attachComposerSmoothCaret } from "./composerSmoothCaret";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: { inline: true },
  },
});
let view: EditorView;
let host: HTMLDivElement;
let dispose: (() => void) | undefined;
let frame: FrameRequestCallback | null;
let animation: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> };
let animate: ReturnType<typeof vi.fn>;
let media: EventTarget & { matches: boolean };
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

beforeEach(() => {
  frame = null;
  animation = { onfinish: null, cancel: vi.fn() };
  animate = vi.fn(() => animation);
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = null;
  });
  host = document.createElement("div");
  host.setAttribute("data-composer-caret-host", "");
  document.body.append(host);
  Object.defineProperties(host, { offsetWidth: { value: 800 }, offsetHeight: { value: 200 } });
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 200));
  const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("hello"))]);
  view = new EditorView(host, {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, 6) }),
  });
  vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 200));
  vi.spyOn(view, "coordsAtPos").mockImplementation((pos) => ({
    left: 20 + pos * 8,
    right: 20 + pos * 8,
    top: 20,
    bottom: 38,
  }));
  view.focus();
  dispose = attachComposerSmoothCaret(view);
});

afterEach(() => {
  dispose?.();
  view.destroy();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

function input(inputType = "insertText", isComposing = false) {
  view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType, isComposing, bubbles: true }));
}

function paint() {
  const callback = frame;
  frame = null;
  callback?.(0);
}

describe("composer typing caret", () => {
  it("moves for a keystroke without changing text, then restores the native caret", () => {
    input();
    view.dispatch(view.state.tr.insertText("!"));
    paint();
    expect(view.state.doc.textContent).toBe("hello!");
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translate(68px, 20px)" }, { transform: "translate(76px, 20px)" }],
      { duration: 45, easing: "ease-out" },
    );
    expect(host.hasAttribute("data-composer-caret-moving")).toBe(true);
    expect(view.dom.hasAttribute("data-composer-caret-moving")).toBe(false);
    expect(view.dom.querySelector(".composer-moving-caret")).toBeNull();
    animation.onfinish?.();
    expect(host.hasAttribute("data-composer-caret-moving")).toBe(false);
  });

  it("reuses the mounted overlay across keystrokes without moving DOM nodes", () => {
    const caret = host.querySelector(".composer-moving-caret");
    const append = vi.spyOn(host, "append");
    for (const letter of "world") {
      input();
      view.dispatch(view.state.tr.insertText(letter));
      paint();
      animation.onfinish?.();
    }
    expect(append).not.toHaveBeenCalled();
    expect(host.querySelector(".composer-moving-caret")).toBe(caret);
    expect(animate).toHaveBeenCalledTimes(5);
    expect(view.state.doc.textContent).toBe("helloworld");
  });

  it.each(["insertFromPaste", "insertFromDrop", "insertParagraph", "historyUndo"])(
    "leaves %s to the native editor",
    (inputType) => {
      input(inputType);
      view.dispatch(view.state.tr.insertText(" pasted"));
      paint();
      expect(animate).not.toHaveBeenCalled();
      expect(view.state.doc.textContent).toBe("hello pasted");
      expect(host.hasAttribute("data-composer-caret-moving")).toBe(false);
    },
  );

  it("does not animate composition input or range replacement", () => {
    input("insertText", true);
    view.dispatch(view.state.tr.insertText("語"));
    paint();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    input();
    view.dispatch(view.state.tr.insertText("a"));
    paint();
    expect(animate).not.toHaveBeenCalled();
  });

  it("snaps to a wrapped line", () => {
    input();
    view.dispatch(view.state.tr.insertText("!"));
    vi.mocked(view.coordsAtPos).mockReturnValue({ left: 20, right: 20, top: 44, bottom: 62 });
    paint();
    expect(animate).not.toHaveBeenCalled();
  });

  it("uses native movement when reduced motion is requested", () => {
    media.matches = true;
    input();
    view.dispatch(view.state.tr.insertText("!"));
    paint();
    expect(animate).not.toHaveBeenCalled();
  });

  it.each(["pointerdown", "compositionstart", "blur", "scroll"])(
    "stops an active movement on %s",
    (event) => {
      input();
      view.dispatch(view.state.tr.insertText("!"));
      paint();
      view.dom.dispatchEvent(new Event(event));
      expect(animation.cancel).toHaveBeenCalled();
      expect(host.hasAttribute("data-composer-caret-moving")).toBe(false);
    },
  );

  it("cleans up an outstanding frame when the editor unmounts", () => {
    input();
    view.dispatch(view.state.tr.insertText("!"));
    dispose?.();
    paint();
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector(".composer-moving-caret")).toBeNull();
  });
});

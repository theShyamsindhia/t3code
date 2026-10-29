import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";
import { attachComposerSmoothCaret } from "./composerSmoothCaret";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: { inline: true },
  },
});

function mountComposer() {
  using stack = new DisposableStack();
  // Frames and animations are driven by hand so each test sees exactly one typing frame.
  let frame: FrameRequestCallback | null = null;
  stack.use(
    stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
  );
  stack.use(
    stubGlobal("cancelAnimationFrame", () => {
      frame = null;
    }),
  );
  const media = Object.assign(new EventTarget(), { matches: false });
  stack.use(stubGlobal("matchMedia", () => media));
  const animation = { onfinish: null as (() => void) | null, cancel: vi.fn() };
  const animate = stack.use(
    vi.spyOn(Element.prototype, "animate").mockImplementation(() => animation as never),
  );

  const host = document.createElement("div");
  host.setAttribute("data-composer-caret-host", "");
  host.style.cssText = "position: fixed; left: 0; top: 0; width: 800px; height: 200px";
  document.body.append(host);
  stack.defer(() => host.remove());
  const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("hello"))]);
  const view = new EditorView(host, {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, 6) }),
  });
  stack.defer(() => view.destroy());
  stack.use(
    vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 200)),
  );
  const coordsAtPos = stack.use(
    vi.spyOn(view, "coordsAtPos").mockImplementation((pos) => ({
      left: 20 + pos * 8,
      right: 20 + pos * 8,
      top: 20,
      bottom: 38,
    })),
  );
  view.focus();
  const dispose = attachComposerSmoothCaret(view);
  stack.defer(() => dispose?.());

  const owned = stack.move();
  return {
    view,
    host,
    media,
    animation,
    animate,
    coordsAtPos,
    unmount: () => dispose?.(),
    input(inputType = "insertText", isComposing = false) {
      view.dom.dispatchEvent(
        new InputEvent("beforeinput", { inputType, isComposing, bubbles: true }),
      );
    },
    paint() {
      const callback = frame;
      frame = null;
      callback?.(0);
    },
    [Symbol.dispose]: () => owned.dispose(),
  };
}

describe("composer typing caret", () => {
  it("moves for a keystroke without changing text, then restores the native caret", () => {
    using composer = mountComposer();
    const { view, host } = composer;
    composer.input();
    view.dispatch(view.state.tr.insertText("!"));
    composer.paint();
    expect(view.state.doc.textContent).toBe("hello!");
    expect(composer.animate).toHaveBeenCalledWith(
      [{ transform: "translate(68px, 20px)" }, { transform: "translate(76px, 20px)" }],
      { duration: 45, easing: "ease-out" },
    );
    expect(host.hasAttribute("data-composer-caret-moving")).toBe(true);
    expect(view.dom.hasAttribute("data-composer-caret-moving")).toBe(false);
    expect(view.dom.querySelector(".composer-moving-caret")).toBeNull();
    composer.animation.onfinish?.();
    expect(host.hasAttribute("data-composer-caret-moving")).toBe(false);
  });

  it("reuses the mounted overlay across keystrokes without moving DOM nodes", () => {
    using composer = mountComposer();
    const { view, host } = composer;
    const caret = host.querySelector(".composer-moving-caret");
    using append = vi.spyOn(host, "append");
    for (const letter of "world") {
      composer.input();
      view.dispatch(view.state.tr.insertText(letter));
      composer.paint();
      composer.animation.onfinish?.();
    }
    expect(append).not.toHaveBeenCalled();
    expect(host.querySelector(".composer-moving-caret")).toBe(caret);
    expect(composer.animate).toHaveBeenCalledTimes(5);
    expect(view.state.doc.textContent).toBe("helloworld");
  });

  it.each(["insertFromPaste", "insertFromDrop", "insertParagraph", "historyUndo"])(
    "leaves %s to the native editor",
    (inputType) => {
      using composer = mountComposer();
      const { view, host } = composer;
      composer.input(inputType);
      view.dispatch(view.state.tr.insertText(" pasted"));
      composer.paint();
      expect(composer.animate).not.toHaveBeenCalled();
      expect(view.state.doc.textContent).toBe("hello pasted");
      expect(host.hasAttribute("data-composer-caret-moving")).toBe(false);
    },
  );

  it("does not animate composition input or range replacement", () => {
    using composer = mountComposer();
    const { view } = composer;
    composer.input("insertText", true);
    view.dispatch(view.state.tr.insertText("語"));
    composer.paint();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    composer.input();
    view.dispatch(view.state.tr.insertText("a"));
    composer.paint();
    expect(composer.animate).not.toHaveBeenCalled();
  });

  it("snaps to a wrapped line", () => {
    using composer = mountComposer();
    const { view } = composer;
    composer.input();
    view.dispatch(view.state.tr.insertText("!"));
    composer.coordsAtPos.mockReturnValue({ left: 20, right: 20, top: 44, bottom: 62 });
    composer.paint();
    expect(composer.animate).not.toHaveBeenCalled();
  });

  it("uses native movement when reduced motion is requested", () => {
    using composer = mountComposer();
    const { view } = composer;
    composer.media.matches = true;
    composer.input();
    view.dispatch(view.state.tr.insertText("!"));
    composer.paint();
    expect(composer.animate).not.toHaveBeenCalled();
  });

  it.each(["pointerdown", "compositionstart", "blur", "scroll"])(
    "stops an active movement on %s",
    (event) => {
      using composer = mountComposer();
      const { view, host } = composer;
      composer.input();
      view.dispatch(view.state.tr.insertText("!"));
      composer.paint();
      view.dom.dispatchEvent(new Event(event));
      expect(composer.animation.cancel).toHaveBeenCalled();
      expect(host.hasAttribute("data-composer-caret-moving")).toBe(false);
    },
  );

  it("cleans up an outstanding frame when the editor unmounts", () => {
    using composer = mountComposer();
    const { view, host } = composer;
    composer.input();
    view.dispatch(view.state.tr.insertText("!"));
    composer.unmount();
    composer.paint();
    expect(composer.animate).not.toHaveBeenCalled();
    expect(host.querySelector(".composer-moving-caret")).toBeNull();
  });
});

import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Briefly animate typing movement, then hand blinking back to the native caret. */
export function attachComposerSmoothCaret(view: EditorView) {
  const document = view.dom.ownerDocument;
  const window = document.defaultView;
  const parent = view.dom.closest<HTMLElement>("[data-composer-caret-host]");
  if (!window || !parent || typeof view.dom.animate !== "function") return;

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce), (forced-colors: active)",
  );
  const caret = document.createElement("span");
  caret.className = "composer-moving-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.style.visibility = "hidden";
  // Mount once outside contenteditable; typing only updates the overlay's style.
  parent.append(caret);
  let frame: number | null = null;
  let animation: Animation | null = null;
  let animatedHead: number | null = null;

  const eligible = () =>
    !reducedMotion.matches &&
    !view.isDestroyed &&
    view.editable &&
    view.hasFocus() &&
    !view.composing &&
    view.state.selection instanceof TextSelection &&
    view.state.selection.empty;

  const stop = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (animation) {
      animation.onfinish = null;
      animation.cancel();
      caret.style.visibility = "hidden";
      parent.removeAttribute("data-composer-caret-moving");
    }
    animation = null;
    animatedHead = null;
  };

  const beforeInput = (event: InputEvent) => {
    if (
      event.isComposing ||
      !["insertText", "deleteContentBackward", "deleteContentForward"].includes(event.inputType) ||
      !eligible()
    ) {
      stop();
      return;
    }
    const from = animation
      ? caret.getBoundingClientRect()
      : view.coordsAtPos(view.state.selection.head);
    const previousDoc = view.state.doc;
    stop();
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!eligible() || view.state.doc === previousDoc) return;
      const to = view.coordsAtPos(view.state.selection.head);
      const bounds = view.dom.getBoundingClientRect();
      // Wraps, scrolling, and large replacements should land immediately.
      if (
        Math.abs(to.top - from.top) > 2 ||
        Math.abs(to.left - from.left) > (to.bottom - to.top) * 3 ||
        to.left === from.left ||
        to.top < bounds.top ||
        to.bottom > bounds.bottom ||
        to.left < bounds.left ||
        to.left > bounds.right
      )
        return;

      // Read geometry before changing styles, avoiding a second layout flush.
      const parentBounds = parent.getBoundingClientRect();
      const scaleX = parentBounds.width / parent.offsetWidth;
      const scaleY = parentBounds.height / parent.offsetHeight;
      if (!scaleX || !scaleY) {
        stop();
        return;
      }
      const x = (to.left - parentBounds.left) / scaleX + parent.scrollLeft - parent.clientLeft;
      const y = (to.top - parentBounds.top) / scaleY + parent.scrollTop - parent.clientTop;
      const startX = x + (from.left - to.left) / scaleX;
      const transform = `translate(${x}px, ${y}px)`;
      caret.style.height = `${(to.bottom - to.top) / scaleY}px`;
      caret.style.transform = transform;
      caret.style.visibility = "visible";
      animation = caret.animate([{ transform: `translate(${startX}px, ${y}px)` }, { transform }], {
        duration: 45,
        easing: "ease-out",
      });
      animatedHead = view.state.selection.head;
      // Do not mutate ProseMirror's observed DOM just to hide its native caret.
      parent.setAttribute("data-composer-caret-moving", "");
      animation.onfinish = stop;
    });
  };

  const keyDown = (event: KeyboardEvent) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      (event.key.length > 1 && !["Backspace", "Delete"].includes(event.key))
    )
      stop();
  };
  const selectionChange = () => {
    if (frame === null && animation === null) return;
    if (!eligible() || (animation && view.state.selection.head !== animatedHead)) stop();
  };
  view.dom.addEventListener("beforeinput", beforeInput);
  view.dom.addEventListener("keydown", keyDown);
  view.dom.addEventListener("pointerdown", stop);
  view.dom.addEventListener("compositionstart", stop);
  view.dom.addEventListener("blur", stop);
  document.addEventListener("scroll", stop, true);
  document.addEventListener("selectionchange", selectionChange);
  window.addEventListener("resize", stop);
  reducedMotion.addEventListener("change", stop);

  return () => {
    stop();
    caret.remove();
    view.dom.removeEventListener("beforeinput", beforeInput);
    view.dom.removeEventListener("keydown", keyDown);
    view.dom.removeEventListener("pointerdown", stop);
    view.dom.removeEventListener("compositionstart", stop);
    view.dom.removeEventListener("blur", stop);
    document.removeEventListener("scroll", stop, true);
    document.removeEventListener("selectionchange", selectionChange);
    window.removeEventListener("resize", stop);
    reducedMotion.removeEventListener("change", stop);
  };
}

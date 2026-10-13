import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import type { DesktopBridge } from "@t3tools/contracts";

export const DESKTOP_PASTE_AS_TEXT_EVENT = "t3:paste-as-text";

/** Arm composer paste handling before Electron delivers the native clipboard event. */
export function installDesktopPasteAsText(
  bridge: Pick<DesktopBridge, "onMenuAction" | "pasteAsText"> | undefined,
  target: EventTarget,
): (() => void) | undefined {
  return bridge?.onMenuAction((action) => {
    if (action !== "paste-as-text") return;
    target.dispatchEvent(new Event(DESKTOP_PASTE_AS_TEXT_EVENT));
    void bridge.pasteAsText?.();
  });
}

/** Keep a paste command through a busy renderer, but never through another user action. */
export function trackPasteAsTextIntent(target: EventTarget, macPlatform: boolean) {
  let pending = false;
  const arm = () => {
    pending = true;
  };
  const reset = () => {
    pending = false;
  };
  const onKeyDown = (event: Event) => {
    pending = isPasteAsTextShortcut(event as KeyboardEvent, macPlatform);
  };
  // Let the composer consume the intent first, then clear pastes handled elsewhere.
  target.addEventListener("paste", reset);
  target.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, arm);
  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("pointerdown", reset, true);
  target.addEventListener("blur", reset);
  return {
    consume: () => {
      const result = pending;
      pending = false;
      return result;
    },
    dispose: () => {
      reset();
      target.removeEventListener("paste", reset);
      target.removeEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, arm);
      target.removeEventListener("keydown", onKeyDown, true);
      target.removeEventListener("pointerdown", reset, true);
      target.removeEventListener("blur", reset);
    },
  };
}

import type { DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DESKTOP_PASTE_AS_TEXT_EVENT,
  installDesktopPasteAsText,
  trackPasteAsTextIntent,
} from "./desktopPasteAsText";

describe("desktop paste as text", () => {
  it.each([false, true])("pastes with a mounted composer: %s", (hasComposer) => {
    const target = new EventTarget();
    let menuAction: ((action: string) => void) | undefined;
    const order: string[] = [];
    const bridge = {
      onMenuAction: (listener) => {
        menuAction = listener;
        return () => {
          menuAction = undefined;
        };
      },
      pasteAsText: vi.fn(async () => {
        order.push("paste");
      }),
    } satisfies Pick<DesktopBridge, "onMenuAction" | "pasteAsText">;
    if (hasComposer)
      target.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, () => order.push("armed"));
    const uninstall = installDesktopPasteAsText(bridge, target);
    menuAction?.("open-settings");
    expect(order).toEqual([]);
    menuAction?.("paste-as-text");
    expect(order).toEqual(hasComposer ? ["armed", "paste"] : ["paste"]);
    uninstall?.();
    menuAction?.("paste-as-text");
    expect(bridge.pasteAsText).toHaveBeenCalledOnce();
  });
});

describe("paste as text intent", () => {
  const key = (target: EventTarget, shiftKey: boolean) =>
    target.dispatchEvent(
      Object.assign(new Event("keydown"), {
        key: "v",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey,
      }),
    );

  it("keeps a delayed keyboard paste inline and consumes the command once", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const intent = trackPasteAsTextIntent(target, true);
    try {
      key(target, true);
      vi.advanceTimersByTime(5_000);
      expect(intent.consume()).toBe(true);
      expect(intent.consume()).toBe(false);
    } finally {
      intent.dispose();
      vi.useRealTimers();
    }
  });

  it("replaces an unused shortcut with the next regular paste", () => {
    const target = new EventTarget();
    const intent = trackPasteAsTextIntent(target, true);
    key(target, true);
    key(target, false);
    expect(intent.consume()).toBe(false);
    intent.dispose();
  });

  it.each(["pointerdown", "blur"])("cancels a pending menu paste on %s", (event) => {
    const target = new EventTarget();
    const intent = trackPasteAsTextIntent(target, true);
    target.dispatchEvent(new Event(DESKTOP_PASTE_AS_TEXT_EVENT));
    target.dispatchEvent(new Event(event));
    expect(intent.consume()).toBe(false);
    intent.dispose();
  });

  it("clears an intent when another input handles the clipboard event", () => {
    const target = new EventTarget();
    const intent = trackPasteAsTextIntent(target, true);
    target.dispatchEvent(new Event(DESKTOP_PASTE_AS_TEXT_EVENT));
    target.dispatchEvent(new Event("paste"));
    expect(intent.consume()).toBe(false);
    intent.dispose();
  });
});

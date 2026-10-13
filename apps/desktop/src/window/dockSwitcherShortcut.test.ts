import { describe, expect, it, vi } from "vite-plus/test";
import { forwardDockSwitcherShortcut } from "./dockSwitcherShortcut.ts";

describe("embedded browser chat switch shortcut", () => {
  const input = {
    type: "keyDown",
    key: "Tab",
    control: true,
    meta: false,
    alt: false,
    shift: false,
  } as const;
  it.each([false, true])("focuses the host and forwards cycling (reverse: %s)", (shift) => {
    const order: string[] = [];
    const preventDefault = vi.fn();
    forwardDockSwitcherShortcut(
      { preventDefault },
      { ...input, shift },
      {
        isGuestFocused: () => true,
        focus: () => {
          order.push("focus");
        },
        send: (action) => {
          order.push(action);
        },
      },
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(order).toEqual(["focus", shift ? "dock-switcher-previous" : "dock-switcher-next"]);
  });
  it("does not steal focus from background browser automation", () => {
    const focus = vi.fn();
    const send = vi.fn();
    const preventDefault = vi.fn();
    forwardDockSwitcherShortcut({ preventDefault }, input, {
      isGuestFocused: () => false,
      focus,
      send,
    });
    expect(focus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it.each([
    { control: false },
    { meta: true },
    { alt: true },
    { key: "w" },
    { type: "keyUp" as const },
  ])("leaves other browser/OS shortcuts alone: %o", (override) => {
    const focus = vi.fn();
    const send = vi.fn();
    const preventDefault = vi.fn();
    forwardDockSwitcherShortcut(
      { preventDefault },
      { ...input, ...override },
      { isGuestFocused: () => true, focus, send },
    );
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

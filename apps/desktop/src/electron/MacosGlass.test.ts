import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMacosGlassController } from "./MacosGlass.ts";

function fakeWindow() {
  const handle = Buffer.alloc(8);
  return {
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    getNativeWindowHandle: () => handle,
  } as unknown as BrowserWindow;
}

function fixture() {
  const addView = vi.fn(() => ({
    remove: vi.fn(),
    setCornerRadius: vi.fn(),
    setDarkAppearance: vi.fn(),
    setStyle: vi.fn(),
  }));
  return { addView, controller: createMacosGlassController({ addView }) };
}

describe("MacosGlass window lifecycle", () => {
  it("reuses the native view for appearance updates and releases it when glass is disabled", () => {
    const { controller, addView } = fixture();
    const window = fakeWindow();
    controller.sync(window, true, true);
    controller.sync(window, true, false);
    expect(addView).toHaveBeenCalledTimes(1);
    const view = addView.mock.results[0]!.value;
    expect(view.setDarkAppearance.mock.calls).toEqual([[true], [false]]);
    controller.sync(window, false, true);
    controller.sync(window, false, true);
    expect(view.remove).toHaveBeenCalledTimes(1);
    controller.sync(window, true, true);
    expect(addView).toHaveBeenCalledTimes(2);
  });

  it("switches between Clear and Regular on the same native view", () => {
    const { controller, addView } = fixture();
    const window = fakeWindow();
    controller.sync(window, true, true, "clear");
    controller.sync(window, true, true, "regular");
    expect(addView).toHaveBeenCalledTimes(1);
    expect(addView.mock.results[0]!.value.setStyle.mock.calls).toEqual([["clear"], ["regular"]]);
  });

  it("removes only the selected window's glass", () => {
    const { controller, addView } = fixture();
    const first = fakeWindow();
    const second = fakeWindow();
    controller.sync(first, true, true);
    controller.sync(second, true, true);
    controller.sync(first, false, true);
    expect(addView.mock.results[0]!.value.remove).toHaveBeenCalledTimes(1);
    expect(addView.mock.results[1]!.value.remove).not.toHaveBeenCalled();
  });

  it("fits fullscreen and restores the window's rounded corners on exit", () => {
    const { controller, addView } = fixture();
    const window = fakeWindow();
    controller.sync(window, true, true);
    const view = addView.mock.results[0]!.value;
    expect(view.setCornerRadius).toHaveBeenLastCalledWith(16);
    vi.mocked(window.isFullScreen).mockReturnValue(true);
    controller.syncCorners(window);
    expect(view.setCornerRadius).toHaveBeenLastCalledWith(0);
    vi.mocked(window.isFullScreen).mockReturnValue(false);
    controller.syncCorners(window);
    expect(view.setCornerRadius).toHaveBeenLastCalledWith(16);
  });

  it("never touches a view released by a destroyed window", () => {
    const { controller, addView } = fixture();
    const window = fakeWindow();
    controller.sync(window, true, true);
    const view = addView.mock.results[0]!.value;
    vi.mocked(window.isDestroyed).mockReturnValue(true);
    controller.sync(window, false, true);
    controller.syncCorners(window);
    expect(view.remove).not.toHaveBeenCalled();
    expect(view.setCornerRadius).toHaveBeenCalledTimes(1);
  });
});

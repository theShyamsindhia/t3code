import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readFrameHour, subscribeToFrameHour } from "./useFrameHour";

describe("hourly frame", () => {
  let unsubscribe: (() => void) | undefined;
  let visibility: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 6, 42, 12, 125));
    visibility = "visible";
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal(
      "document",
      Object.defineProperty(new EventTarget(), "visibilityState", { get: () => visibility }),
    );
  });

  afterEach(() => {
    unsubscribe?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays still until the next local hour, then advances once", () => {
    const change = vi.fn();
    unsubscribe = subscribeToFrameHour(change);
    change.mockClear();
    vi.advanceTimersByTime(1_067_874);
    expect(change).not.toHaveBeenCalled();
    expect(readFrameHour()).toBe(6);
    vi.advanceTimersByTime(1);
    expect(change).toHaveBeenCalledTimes(1);
    expect(readFrameHour()).toBe(7);
    vi.advanceTimersByTime(3_600_000);
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("stops waking a hidden tab and catches up when it returns", () => {
    const change = vi.fn();
    unsubscribe = subscribeToFrameHour(change);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    change.mockClear();
    vi.advanceTimersByTime(3 * 3_600_000);
    expect(change).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(change).toHaveBeenCalledOnce();
    expect(readFrameHour()).toBe(9);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reschedules after a clock change and removes its timer and listeners on exit", () => {
    const change = vi.fn();
    unsubscribe = subscribeToFrameHour(change);
    vi.setSystemTime(new Date(2026, 9, 3, 23, 59, 59));
    window.dispatchEvent(new Event("focus"));
    change.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(change).toHaveBeenCalledOnce();
    expect(readFrameHour()).toBe(0);
    unsubscribe();
    change.mockClear();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(3_600_000);
    expect(change).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

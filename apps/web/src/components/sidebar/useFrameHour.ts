import { useSyncExternalStore } from "react";

export function readFrameHour() {
  return new Date().getHours();
}

// Paint once at the local hour boundary, and catch up after the window sleeps.
export function subscribeToFrameHour(onChange: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    clearTimeout(timer);
    onChange();
    if (document.visibilityState === "hidden") return;
    const now = new Date();
    const remaining =
      3_600_000 - now.getMinutes() * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds();
    timer = setTimeout(refresh, remaining);
  };
  refresh();
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

const subscribeToNothing = () => () => {};

export function useFrameHour(enabled: boolean) {
  return useSyncExternalStore(enabled ? subscribeToFrameHour : subscribeToNothing, readFrameHour);
}

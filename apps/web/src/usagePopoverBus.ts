const OPEN_USAGE_POPOVER = "t3code:open-usage-popover";

/** Returns false when there is no visible usage trigger, so callers can open the page. */
export function openUsagePopover(): boolean {
  return !window.dispatchEvent(new Event(OPEN_USAGE_POPOVER, { cancelable: true }));
}

export function onOpenUsagePopover(listener: () => void): () => void {
  const handler = (event: Event) => {
    event.preventDefault();
    listener();
  };
  window.addEventListener(OPEN_USAGE_POPOVER, handler);
  return () => window.removeEventListener(OPEN_USAGE_POPOVER, handler);
}

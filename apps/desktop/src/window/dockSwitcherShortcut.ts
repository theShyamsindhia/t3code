/** Only human input in the focused guest may hand this gesture to the app. */
export function forwardDockSwitcherShortcut(
  event: { preventDefault: () => void },
  input: Pick<Electron.Input, "type" | "key" | "control" | "meta" | "alt" | "shift">,
  host: { isGuestFocused: () => boolean; focus: () => void; send: (action: string) => void },
): void {
  if (
    input.type !== "keyDown" ||
    input.key !== "Tab" ||
    !input.control ||
    input.meta ||
    input.alt ||
    !host.isGuestFocused()
  )
    return;
  event.preventDefault();
  host.focus();
  host.send(input.shift ? "dock-switcher-previous" : "dock-switcher-next");
}

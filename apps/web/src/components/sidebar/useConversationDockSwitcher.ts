import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";

export function useConversationDockSwitcher<T extends { key: string }>(input: {
  getEntries: () => readonly T[];
  activeKey: string | null;
  onSelect: (entry: T) => void;
}) {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  }, [input]);
  const [choice, setChoice] = useState<{
    entries: readonly T[];
    index: number;
    activeKey: string | null;
  } | null>(null);
  const choiceRef = useRef(choice);

  useEffect(() => {
    const update = (value: typeof choice) => {
      choiceRef.current = value;
      setChoice(value);
    };
    const cancel = () => update(null);
    const cycle = (direction: number) => {
      if (
        isCommandPaletteOpen() ||
        isModelPickerOpen() ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="select-popup"]',
        )
      )
        return false;
      const current =
        choiceRef.current?.activeKey === latest.current.activeKey ? choiceRef.current : null;
      const entries = current?.entries ?? latest.current.getEntries();
      if (entries.length === 0) return false;
      const from =
        current?.index ?? entries.findIndex((entry) => entry.key === latest.current.activeKey);
      const index =
        from < 0
          ? direction > 0
            ? 0
            : entries.length - 1
          : (from + direction + entries.length) % entries.length;
      update({ entries, index, activeKey: latest.current.activeKey });
      return true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey) {
        if (cycle(event.shiftKey ? -1 : 1)) {
          event.preventDefault();
          event.stopPropagation();
        }
      } else if (choiceRef.current && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (choiceRef.current && event.key !== "Shift" && event.key !== "Control") {
        cancel();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control" || event.ctrlKey) return;
      const current = choiceRef.current;
      if (!current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      const selected = current.entries[current.index];
      if (selected && current.activeKey === latest.current.activeKey)
        latest.current.onSelect(selected);
    };
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "dock-switcher-next") cycle(1);
      if (action === "dock-switcher-previous") cycle(-1);
    });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerdown", cancel, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe?.();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return choice?.activeKey === input.activeKey ? choice : null;
}

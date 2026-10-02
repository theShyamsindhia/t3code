import { AlarmClockIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function ConversationDockViews({
  value,
  onChange,
  settledCount,
  snoozedCount,
}: {
  value: "working" | "settled" | "snoozed";
  onChange: (value: "working" | "settled" | "snoozed") => void;
  settledCount: number;
  snoozedCount: number;
}) {
  return (
    <div data-conversation-dock-views="" role="group" aria-label="Conversation view">
      <button type="button" aria-pressed={value === "working"} onClick={() => onChange("working")}>
        Working
      </button>
      <button type="button" aria-pressed={value === "settled"} onClick={() => onChange("settled")}>
        Settled <span>{settledCount}</span>
      </button>
      {snoozedCount > 0 ? (
        <SidebarHeaderIconButton
          label={`Snoozed chats (${snoozedCount})`}
          aria-pressed={value === "snoozed"}
          onClick={() => onChange(value === "snoozed" ? "working" : "snoozed")}
        >
          <AlarmClockIcon />
        </SidebarHeaderIconButton>
      ) : null}
    </div>
  );
}

/** Four compact chats share the strip; each view retains its own scroll position. */
export function ConversationDockContent({
  fixedHeader,
  children,
  viewKey = "working",
  onReachEnd,
}: ComponentProps<"div"> & {
  fixedHeader?: ReactNode;
  viewKey?: string;
  onReachEnd?: (() => void) | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollLeft = positions.current.get(viewKey) ?? 0;
  }, [viewKey]);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || event.shiftKey || event.ctrlKey) return;
      event.preventDefault();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? node.clientWidth : 1);
      node.scrollLeft += delta;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <>
      <div
        ref={scrollRef}
        data-conversation-dock-scroll=""
        tabIndex={0}
        role="region"
        aria-label="Chat strip"
        onScroll={(event) => {
          const node = event.currentTarget;
          positions.current.set(viewKey, node.scrollLeft);
          if (node.scrollLeft + node.clientWidth >= node.scrollWidth - 32) onReachEnd?.();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const node = event.currentTarget;
          const direction =
            event.key === "ArrowRight" || event.key === "PageDown"
              ? 1
              : event.key === "ArrowLeft" || event.key === "PageUp"
                ? -1
                : 0;
          if (!direction) return;
          event.preventDefault();
          node.scrollLeft +=
            direction * (event.key.startsWith("Page") ? node.clientWidth : node.clientWidth / 4);
        }}
      >
        {children}
      </div>
      <div data-conversation-dock-controls="">{fixedHeader}</div>
    </>
  );
}

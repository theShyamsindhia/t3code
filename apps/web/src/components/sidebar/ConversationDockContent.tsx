import type { ComponentProps, ReactNode } from "react";

/** Keep the shared search and thread controls beside a horizontally scrolling list. */
export function ConversationDockContent({
  fixedHeader,
  children,
}: ComponentProps<"div"> & { fixedHeader?: ReactNode }) {
  return (
    <>
      <div data-conversation-dock-controls="">{fixedHeader}</div>
      <div
        data-conversation-dock-scroll=""
        onWheel={(event) => {
          // Trackpads keep native horizontal scrolling; a mouse wheel moves the row.
          if (event.deltaX !== 0 || event.shiftKey || event.ctrlKey) return;
          event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        {children}
      </div>
    </>
  );
}

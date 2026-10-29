import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowDownToLineIcon,
  SquarePenIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Pills own their look. Thread state and handlers come from SidebarThreadRow and
// SidebarDraftBlock, so a pill never derives row data of its own.
const pillSurfaceClassName =
  "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const pillDraftTintClassName = "bg-warning/4 hover:bg-warning/8";
const pillActionClassName =
  "pointer-events-none absolute inset-y-0 right-0 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md bg-transparent p-0 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100";

type ConversationDockPillAction = "settle" | "unsettle" | "unsnooze";

interface ConversationDockThreadPillProps {
  readonly threadKey: string;
  readonly attachRow: (row: HTMLElement | null) => (() => void) | undefined;
  readonly label: string;
  readonly ariaCurrent: "page" | undefined;
  readonly regeneratingTitle: boolean;
  readonly isActive: boolean;
  readonly isSelected: boolean;
  readonly isSwept: boolean;
  readonly isDragging: boolean;
  readonly isFileDragOver: boolean;
  readonly hasUnsentDraft: boolean;
  readonly recedes: boolean;
  readonly settled: boolean;
  readonly isWoke: boolean;
  readonly project: ProjectFaviconProject | null;
  readonly status: { readonly label: string; readonly className: string } | null;
  readonly snoozeWakeLabel: string | null;
  /** Null when the thread's environment cannot run the action. */
  readonly action: ConversationDockPillAction | null;
  readonly title: ReactNode;
  readonly accessibleTitle: ReactNode;
  readonly draftIndicator: ReactNode;
  readonly pinIndicator: ReactNode;
  readonly dropBadge: ReactNode;
  readonly jumpBadge: ReactNode;
  readonly details: ReactNode;
  readonly onClick: (event: ReactMouseEvent) => void;
  readonly onDoubleClick: (event: ReactMouseEvent) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  readonly onAction: (event: ReactMouseEvent) => void;
  readonly onActionPointerDown: (event: ReactPointerEvent) => void;
  readonly onAcknowledgeWoke: (event: ReactMouseEvent) => void;
}

/** One chat in the conversation dock. The caller supplies the sortable list item around it. */
export function ConversationDockThreadPill({
  attachRow,
  ...props
}: ConversationDockThreadPillProps) {
  const actionClassName = cn(
    pillActionClassName,
    props.isWoke && "group-any-hover/sidebar-row:static",
  );
  return (
    <Tooltip disabled={props.isDragging}>
      <TooltipTrigger
        render={
          <div
            ref={attachRow}
            role="button"
            tabIndex={0}
            aria-label={props.label}
            aria-current={props.ariaCurrent}
            data-testid="conversation-dock-row"
            data-conversation-dock-row={props.threadKey}
            aria-busy={props.regeneratingTitle || undefined}
            className={cn(
              pillSurfaceClassName,
              "flex h-[var(--conversation-dock-row-height,2.25rem)] items-center gap-2.5 px-2.5",
              props.isActive
                ? "bg-sidebar-row-active text-sidebar-foreground"
                : props.isSelected || props.isSwept
                  ? "bg-sidebar-row-selected text-sidebar-foreground"
                  : props.hasUnsentDraft
                    ? cn(pillDraftTintClassName, "text-sidebar-foreground")
                    : props.recedes
                      ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
              props.isFileDragOver && "ring-1 ring-inset ring-primary/70",
              props.isFileDragOver &&
                !props.isActive &&
                !props.isSelected &&
                "bg-sidebar-row-hover",
              props.isDragging &&
                "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
            )}
            onClick={props.onClick}
            onDoubleClick={props.onDoubleClick}
            onKeyDown={props.onKeyDown}
            onContextMenu={props.onContextMenu}
          />
        }
      >
        {props.accessibleTitle}
        <span
          className={cn(
            "flex shrink-0 items-center transition-opacity",
            (!props.isActive || props.settled) &&
              "opacity-80 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
          )}
        >
          {props.project ? <ProjectFavicon project={props.project} className="size-4" /> : null}
        </span>
        {props.draftIndicator}
        {props.title}
        {props.pinIndicator}
        {props.status ? (
          <span
            role="status"
            aria-label={props.status.label}
            className={cn("flex shrink-0", props.status.className)}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
          </span>
        ) : null}
        {props.regeneratingTitle ? (
          <span role="status" className="sr-only">
            Regenerating title
          </span>
        ) : null}
        {props.isDragging ? (
          props.dropBadge
        ) : (
          <span
            className={cn(
              "relative ml-auto flex h-6 min-w-6 shrink-0 items-center justify-end",
              props.isSwept && "hidden",
            )}
          >
            <span
              className={cn(
                "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                !props.isWoke && "group-any-hover/sidebar-row:opacity-0",
              )}
            >
              {props.snoozeWakeLabel !== null ? (
                <span className="text-xs text-info-foreground tabular-nums">
                  {props.snoozeWakeLabel}
                </span>
              ) : props.isWoke ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Dismiss Woke notification"
                        onClick={props.onAcknowledgeWoke}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <AlarmClockIcon aria-hidden className="size-3" />
                        <span role="status">Woke</span>
                      </button>
                    }
                  />
                  <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
            {props.action === "unsnooze" ? (
              <button
                type="button"
                aria-label="Wake thread now"
                onClick={props.onAction}
                onPointerDown={props.onActionPointerDown}
                className={actionClassName}
              >
                <AlarmClockOffIcon className="size-3.5" />
              </button>
            ) : props.action === null ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={
                        props.action === "unsettle" ? "Move to Working" : "Move to Settled"
                      }
                      onClick={props.onAction}
                      onPointerDown={props.onActionPointerDown}
                      className={actionClassName}
                    />
                  }
                >
                  {props.action === "unsettle" ? (
                    <Undo2Icon className="size-3.5" />
                  ) : (
                    <ArrowDownToLineIcon aria-hidden className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {props.action === "unsettle" ? "Move to Working" : "Move to Settled"}
                </TooltipPopup>
              </Tooltip>
            )}
          </span>
        )}
        {props.isSwept ? props.dropBadge : null}
        {props.jumpBadge}
      </TooltipTrigger>
      {props.details}
    </Tooltip>
  );
}

/** An unsent draft in the dock's Working view. */
export function ConversationDockDraftPill(props: {
  readonly draftId: string;
  readonly preview: string;
  readonly label: string;
  readonly ariaCurrent: "page" | undefined;
  readonly isActive: boolean;
  readonly project: ProjectFaviconProject | null;
  readonly onActivate: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  readonly onDiscard: (event: ReactMouseEvent) => void;
}) {
  return (
    <li data-thread-item className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={props.label}
        aria-current={props.ariaCurrent}
        data-testid="sidebar-draft-row"
        data-conversation-dock-row={`draft:${props.draftId}`}
        className={cn(
          pillSurfaceClassName,
          "text-sidebar-foreground",
          props.isActive ? "bg-sidebar-row-active" : pillDraftTintClassName,
        )}
        onClick={props.onActivate}
        onContextMenu={props.onContextMenu}
        onKeyDown={props.onKeyDown}
      >
        <span className="sr-only">{props.preview}</span>
        <div className="relative z-10 flex h-[var(--conversation-dock-row-height,2.25rem)] items-center px-(--sidebar-row-content-inset)">
          <div className="flex h-6 min-w-0 flex-1 items-center gap-2.5">
            <SquarePenIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary-label">
              {props.preview}
            </span>
            <span className="ml-auto flex h-6 min-w-6 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={props.onDiscard}
                      className="pointer-events-none inline-flex size-6 cursor-pointer items-center justify-center rounded-md bg-transparent p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

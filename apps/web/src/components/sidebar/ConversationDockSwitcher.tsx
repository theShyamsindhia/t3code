import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { type DraftId } from "../../composerDraftStore";
import { environmentThreadShells, useEnvironmentThread } from "../../state/threads";
import { conversationDockPreview } from "./conversationDockPreview";
import { useConversationDockSwitcher } from "./useConversationDockSwitcher";
import { raiseConversationDockPill } from "./raiseConversationDockPill";

export type DockSwitcherEntry = {
  key: string;
  title: string;
  project: string;
} & (
  | { kind: "thread"; thread: EnvironmentThreadShell }
  | { kind: "draft"; draftId: DraftId; text: string }
);

function ThreadPreview({ thread }: { thread: EnvironmentThreadShell }) {
  const current =
    useAtomValue(
      environmentThreadShells.threadShellAtom(scopeThreadRef(thread.environmentId, thread.id)),
    ) ?? thread;
  const detail = useEnvironmentThread(thread.environmentId, thread.id);
  const preview = conversationDockPreview(current.source, Option.getOrNull(detail.data));
  return (
    <>
      <span data-dock-preview-status="">
        {preview.label}
        {detail.status === "cached" ? " · Cached" : ""}
      </span>
      <p>
        {Option.isNone(detail.data) && Option.isSome(detail.error)
          ? "Preview unavailable. Open this chat to reconnect."
          : preview.text}
      </p>
    </>
  );
}

export function ConversationDockSwitcher(props: {
  listRef: RefObject<HTMLUListElement | null>;
  getEntries: () => readonly DockSwitcherEntry[];
  activeKey: string | null;
  onSelect: (entry: DockSwitcherEntry) => void;
}) {
  const choice = useConversationDockSwitcher(props);
  const entry = choice?.entries[choice.index];
  const key = entry?.key;
  const { listRef } = props;
  const [anchor, setAnchor] = useState<{ key: string; row: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    if (!key) return;
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-conversation-dock-row]") ?? [],
    ).find((node) => node.dataset.conversationDockRow === key);
    if (!row) return;
    const lower = raiseConversationDockPill(row);
    setAnchor({ key, row });
    return lower;
  }, [key, listRef]);
  if (!entry || anchor?.key !== entry.key) return null;
  // Only the focused pill subscribes to chat details, and its title/icon stay in place.
  return createPortal(
    <div data-dock-pill-preview="" role="status" aria-live="polite" key={entry.key}>
      <span className="sr-only">{entry.title}. </span>
      <span data-dock-preview-project="">{entry.project}</span>
      {entry.kind === "thread" ? (
        <ThreadPreview thread={entry.thread} />
      ) : (
        <>
          <span data-dock-preview-status="">Unsent draft</span>
          <p>{entry.text || "Attachments ready to send."}</p>
        </>
      )}
    </div>,
    anchor.row,
  );
}

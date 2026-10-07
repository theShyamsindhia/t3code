import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import { type DraftId } from "../../composerDraftStore";
import { environmentThreadShells, useEnvironmentThread } from "../../state/threads";
import { conversationDockPreview } from "./conversationDockPreview";
import { useConversationDockSwitcher } from "./useConversationDockSwitcher";

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
  getEntries: () => readonly DockSwitcherEntry[];
  activeKey: string | null;
  onSelect: (entry: DockSwitcherEntry) => void;
}) {
  const choice = useConversationDockSwitcher(props);
  if (!choice) return null;
  // Bound detail subscriptions, even when the dock contains hundreds of chats.
  const start = Math.max(0, Math.min(choice.index - 1, choice.entries.length - 3));
  return (
    <div data-conversation-dock-switcher="" role="region" aria-label="Switch chat">
      <div data-dock-preview-cards="">
        {choice.entries.slice(start, start + 3).map((entry, offset) => (
          <article key={entry.key} data-dock-preview-selected={start + offset === choice.index}>
            <span data-dock-preview-project="">{entry.project}</span>
            <h3>{entry.title}</h3>
            {entry.kind === "thread" ? (
              <ThreadPreview thread={entry.thread} />
            ) : (
              <>
                <span data-dock-preview-status="">Unsent draft</span>
                <p>{entry.text || "Attachments ready to send."}</p>
              </>
            )}
          </article>
        ))}
      </div>
      <div data-dock-preview-help="">
        <span>Tab to cycle · Shift Tab to go back · Release Control to open · Esc to cancel</span>
        <span role="status" aria-live="polite">
          {choice.index + 1} / {choice.entries.length} · {choice.entries[choice.index]?.title}
        </span>
      </div>
    </div>
  );
}

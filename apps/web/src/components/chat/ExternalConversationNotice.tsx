import {
  externalSessionSource,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { agentSessionImport } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export function ExternalConversationNotice(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const importSession = useAtomCommand(agentSessionImport, { reportFailure: false });
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = externalSessionSource(props.threadId);
  const takeOver = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        `Stop work in ${source} before continuing. Have you stopped it? T3 will resume this session when you send your next message.`,
      );
      if (!confirmed) return;
      setBusy(true);
      setError(null);
      const result = await importSession({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          takeOverThreadId: props.threadId,
        },
      });
      if (result._tag !== "Success" || result.value.threadId === undefined) {
        setError(
          "Could not take over this conversation. Your original session is unchanged. Try again.",
        );
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: props.environmentId, threadId: result.value.threadId },
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-(--chat-max-width) rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
      <p>Conversation from {source}. History refreshes every minute.</p>
      <p>Stop work in {source} before sending messages from T3.</p>
      {error !== null && <p role="alert">{error}</p>}
      <div className="mt-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void takeOver()}>
          {busy ? "Loading conversation…" : "Continue in T3"}
        </Button>
      </div>
    </div>
  );
}

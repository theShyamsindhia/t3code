import {
  type EnvironmentId,
  type ExternalSessionCandidate,
  type ThreadId,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useEnvironments } from "../../state/environments";
import { externalSessions } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPanel,
} from "../ui/dialog";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

type Scan = {
  environmentId: EnvironmentId;
  label: string;
  candidates: readonly ExternalSessionCandidate[];
  selected: readonly ThreadId[];
  error: string | null;
};

export function ExternalSessionsDialog() {
  const { environments } = useEnvironments();
  const manage = useAtomCommand(externalSessions, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scans, setScans] = useState<Scan[]>([]);
  const generation = useRef(0);
  const scan = async () => {
    const request = ++generation.current;
    setOpen(true);
    setBusy(true);
    setScans([]);
    const results = await Promise.all(
      environments.map(async (environment): Promise<Scan> => {
        const result = await manage({ environmentId: environment.environmentId, input: {} });
        const candidates = result._tag === "Success" ? result.value.candidates : [];
        return {
          environmentId: environment.environmentId,
          label: environment.label,
          candidates,
          selected: candidates.filter((c) => c.tracked).map((c) => c.threadId),
          error:
            result._tag === "Success"
              ? null
              : "Could not scan this environment. Reopen Sync to try again.",
        };
      }),
    );
    if (request !== generation.current) return;
    setScans(results);
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    let failed = false;
    for (const scan of scans) {
      if (scan.error) continue;
      const result = await manage({
        environmentId: scan.environmentId,
        input: { threadIds: scan.selected },
      });
      if (result._tag !== "Success") {
        failed = true;
        setScans((items) =>
          items.map((item) =>
            item.environmentId === scan.environmentId
              ? { ...item, error: "Could not save selection. Reopen Sync to try again." }
              : item,
          ),
        );
      }
    }
    setBusy(false);
    if (!failed) setOpen(false);
  };
  const selectedCount = scans.reduce((count, scan) => count + scan.selected.length, 0);
  return (
    <>
      <SidebarHeaderIconButton label="Sync conversations" onClick={() => void scan()}>
        <RefreshCwIcon />
      </SidebarHeaderIconButton>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (busy && scans.length > 0) return;
          setOpen(value);
          if (!value) generation.current++;
        }}
      >
        <DialogPopup className="max-h-[min(40rem,calc(100dvh-3rem))]">
          <DialogHeader>
            <DialogTitle>Sync conversations</DialogTitle>
            <DialogDescription>
              Choose chats to show in T3. Selected chats refresh automatically. Uncheck a chat to
              archive its preview.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {busy && scans.length === 0 ? (
              <p role="status" className="text-sm text-muted-foreground">
                Looking for conversations…
              </p>
            ) : null}
            {!busy && scans.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment to find conversations.
              </p>
            ) : null}
            {scans.map((scan) => (
              <section key={scan.environmentId} className="space-y-1">
                {scans.length > 1 ? <h3 className="text-sm font-medium">{scan.label}</h3> : null}
                {scan.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {scan.error}
                  </p>
                ) : null}
                {!scan.error && scan.candidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No recent external conversations found.
                  </p>
                ) : null}
                {scan.candidates.map((candidate) => (
                  <label
                    key={candidate.threadId}
                    className="-mx-2 flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted"
                  >
                    <Checkbox
                      checked={scan.selected.includes(candidate.threadId)}
                      disabled={busy || scan.error !== null}
                      onCheckedChange={(checked) =>
                        setScans((items) =>
                          items.map((item) =>
                            item.environmentId === scan.environmentId
                              ? {
                                  ...item,
                                  selected: checked
                                    ? [...item.selected, candidate.threadId]
                                    : item.selected.filter((id) => id !== candidate.threadId),
                                }
                              : item,
                          ),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block truncate">{candidate.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.projectTitle} ·{" "}
                        {candidate.source === "codex" ? "Codex" : "Claude Code"} ·{" "}
                        {new Date(candidate.updatedAt).toLocaleDateString()}
                      </span>
                    </span>
                  </label>
                ))}
              </section>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !scans.some((scan) => !scan.error)}
              onClick={() => void save()}
            >
              {busy && scans.length > 0 ? "Saving…" : `Track selected (${selectedCount})`}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

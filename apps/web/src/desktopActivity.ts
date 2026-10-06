import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type {
  DesktopActivitySnapshot,
  DesktopActivityThread,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";

/** A small status projection; no messages, prompts, or per-token progress cross IPC. */
export function buildDesktopActivitySnapshot(
  environments: readonly {
    environmentId: EnvironmentId;
    label: string;
    shell: EnvironmentShellState;
  }[],
): DesktopActivitySnapshot {
  const attention: DesktopActivityThread[] = [];
  const working: DesktopActivityThread[] = [];
  let unavailableCount = 0;
  for (const { environmentId, label, shell } of environments) {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      unavailableCount++;
      continue;
    }
    const snapshot = shell.snapshot.value;
    const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
    for (const raw of snapshot.threads) {
      if (
        raw.archivedAt !== null ||
        raw.deletedAt !== null ||
        raw.lineage.relationshipToParent === "subagent"
      )
        continue;
      const thread = presentThreadShell(environmentId, raw);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      if (status === "ready") continue;
      if (thread.settledOverride === "settled" && status !== "working" && status !== "waiting")
        continue;
      const entry: DesktopActivityThread = {
        environmentId,
        threadId: thread.id,
        title: thread.title.slice(0, 240),
        project: (projects.get(thread.projectId) ?? "No project").slice(0, 120),
        environment: label.slice(0, 120),
        status,
      };
      (status === "working" || status === "waiting" ? working : attention).push(entry);
    }
  }
  // Stable ordering avoids reshuffling rows as messages stream in.
  const compare = (a: DesktopActivityThread, b: DesktopActivityThread) =>
    a.title.localeCompare(b.title) ||
    a.environmentId.localeCompare(b.environmentId) ||
    a.threadId.localeCompare(b.threadId);
  return {
    threads: [...attention.sort(compare).slice(0, 8), ...working.sort(compare).slice(0, 8)],
    attentionCount: attention.length,
    workingCount: working.length,
    unavailableCount,
  };
}

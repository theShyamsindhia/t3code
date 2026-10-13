import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "./test-fixtures";
import { buildDesktopActivitySnapshot } from "./desktopActivity";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const run = RunId.make("run");
const v2ThreadShell = makeThreadFixture().source;
const running = {
  ...v2ThreadShell,
  status: "running" as const,
  latestRunId: run,
  activeRunId: run,
};
const shell = (threads: readonly OrchestrationV2ThreadShell[] = [running]) => ({
  status: "live" as const,
  snapshot: Option.some({
    schemaVersion: 1 as const,
    snapshotSequence: 0,
    projects: [],
    threads,
    archivedThreads: [],
  }),
  error: Option.none<string>(),
});

describe("desktop activity projection", () => {
  it("removes settled failures from attention without hiding running work", () => {
    const result = buildDesktopActivitySnapshot([
      {
        environmentId: local,
        label: "Mac",
        shell: shell([
          { ...running, status: "failed", settledOverride: "settled" },
          { ...running, id: ThreadId.make("still-running"), settledOverride: "settled" },
        ]),
      },
    ]);
    expect(result.attentionCount).toBe(0);
    expect(result.workingCount).toBe(1);
  });
  it("keeps remote identity, prioritizes questions, and drops completed or removed work", () => {
    const question = {
      ...running,
      title: "A question",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input" as const,
        createdAt: v2ThreadShell.createdAt,
      },
    };
    const result = buildDesktopActivitySnapshot([
      { environmentId: local, label: "This Mac", shell: shell() },
      { environmentId: remote, label: "Remote", shell: shell([question]) },
    ]);
    expect(result.attentionCount).toBe(1);
    expect(result.workingCount).toBe(1);
    expect(result.threads.map((thread) => [thread.environmentId, thread.status])).toEqual([
      [remote, "input"],
      [local, "working"],
    ]);
    const finished = buildDesktopActivitySnapshot([
      {
        environmentId: local,
        label: "This Mac",
        shell: shell([{ ...running, status: "completed" }]),
      },
    ]);
    expect(finished.threads).toEqual([]);
    expect(finished.workingCount).toBe(0);
    expect(buildDesktopActivitySnapshot([]).threads).toEqual([]);
  });

  it("excludes cached activity, archived chats, deleted chats, and hidden subagents", () => {
    const result = buildDesktopActivitySnapshot([
      { environmentId: remote, label: "Remote", shell: { ...shell(), status: "cached" } },
      {
        environmentId: local,
        label: "Mac",
        shell: shell([
          { ...running, archivedAt: running.createdAt },
          { ...running, deletedAt: running.createdAt },
          {
            ...running,
            lineage: {
              ...running.lineage,
              parentThreadId: running.id,
              relationshipToParent: "subagent",
            },
          },
        ]),
      },
    ]);
    expect(result).toEqual({
      threads: [],
      attentionCount: 0,
      workingCount: 0,
      unavailableCount: 1,
    });
  });

  it("bounds the payload while preserving counts and ignoring streaming-only changes", () => {
    const threads = Array.from({ length: 30 }, (_, index) => ({
      ...running,
      id: ThreadId.make(`thread-${index}`),
      title: `Chat ${index}`,
    }));
    const before = buildDesktopActivitySnapshot([
      { environmentId: local, label: "Mac", shell: shell(threads) },
    ]);
    const after = buildDesktopActivitySnapshot([
      {
        environmentId: local,
        label: "Mac",
        shell: shell(
          threads.map((thread) => ({
            ...thread,
            updatedAt: DateTime.makeUnsafe("2026-10-05T12:00:00Z"),
            itemCount: 100,
            visibleItemCount: 100,
          })),
        ),
      },
    ]);
    expect(before.workingCount).toBe(30);
    expect(before.threads).toHaveLength(8);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

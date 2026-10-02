import { ServerSettingsService } from "../serverSettings.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ExternalSessionSync from "./ExternalSessionSync.ts";

const testLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ProjectionThreadRepositoryLive,
  ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-external-sync-test-" })),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      externalSessionThreadIds: [
        ThreadId.make("external:codex:codex:session-codex"),
        ThreadId.make("external:claudeAgent:claudeAgent:123e4567-e89b-42d3-a456-426614174000"),
      ],
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("external-project");
const at = "2026-09-30T10:00:00.000Z";
const sessionId = (source: string) =>
  source === "claudeAgent" ? "123e4567-e89b-42d3-a456-426614174000" : "session-codex";
const externalId = (source: string) =>
  ThreadId.make(`external:${source}:${source}:${sessionId(source)}`);
const transcript = (source: "codex" | "claudeAgent"): AgentSessionScanner.AgentSessionThread => ({
  source,
  providerInstanceId: ProviderInstanceId.make(source),
  providerSessionId: sessionId(source),
  title: "External conversation",
  model: null,
  createdAt: at,
  updatedAt: at,
  messages: [
    { role: "user", text: "hello", createdAt: at },
    { role: "assistant", text: "hi", createdAt: at },
  ],
});

const fixture = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const repository = yield* ProjectionThreadRepository;
  let threads = [transcript("codex"), transcript("claudeAgent")];
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.succeed({ candidates: [], scannedAt: at }),
    recentThreads: (root, _completed, background) => {
      expect(root).toBe("/tmp/external-project");
      if (background !== undefined) expect([true, "discover"]).toContain(background);
      return Stream.fromIterable(
        threads.map((thread) => ({
          _tag: "Importable" as const,
          thread,
          source: {
            provider: thread.source,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: thread.providerSessionId,
            filePath: `/tmp/${thread.source}.jsonl`,
            size: 100,
            mtimeMs: 0,
            device: 1,
            inode: 1,
            birthtimeMs: 0,
          },
        })),
      );
    },
  });
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/external-project",
    defaultModelSelection: null,
    createdAt: at,
  });
  const makeSync = ExternalSessionSync.make.pipe(
    Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
  );
  return {
    engine,
    snapshots,
    directory,
    repository,
    makeSync,
    scanner,
    setThreads: (value: typeof threads) => {
      threads = value;
    },
  };
});

it.effect(
  "mirrors both harnesses, replaces changed history, and skips identical refreshes after restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sync = yield* f.makeSync;
      yield* sync.sweep;
      for (const source of ["codex", "claudeAgent"]) {
        const thread = Option.getOrThrow(
          yield* f.snapshots.getThreadDetailById(externalId(source)),
        );
        expect(thread.messages.map((m) => m.text)).toEqual(["hello", "hi"]);
        expect(thread.session).toBeNull();
        expect(thread.settledOverride).toBeNull();
        expect(Option.isNone(yield* f.directory.getBinding(thread.id))).toBe(true);
      }
      const before = yield* f.engine.latestSequence;
      yield* sync.sweep;
      yield* (yield* f.makeSync).sweep;
      expect(yield* f.engine.latestSequence).toBe(before);
      f.setThreads([
        {
          ...transcript("codex"),
          updatedAt: "2026-09-30T10:01:00.000Z",
          messages: [
            ...transcript("codex").messages,
            { role: "assistant", text: "new response", createdAt: "2026-09-30T10:01:00.000Z" },
          ],
        },
      ]);
      yield* sync.sweep;
      expect(
        Option.getOrThrow(yield* f.snapshots.getThreadDetailById(externalId("codex"))).messages,
      ).toHaveLength(3);
      f.setThreads([
        { ...transcript("codex"), messages: [{ role: "user", text: "edited", createdAt: at }] },
      ]);
      yield* sync.sweep;
      expect(
        Option.getOrThrow(yield* f.snapshots.getThreadDetailById(externalId("codex"))).messages.map(
          (m) => m.text,
        ),
      ).toEqual(["edited"]);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("never resumes an external session and rejects sync into a T3-owned conversation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* (yield* f.makeSync).sweep;
    const started = yield* Effect.result(
      f.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("try-start"),
        threadId: externalId("codex"),
        message: {
          messageId: MessageId.make("new-user-message"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: at,
      }),
    );
    expect(started._tag).toBe("Failure");
    yield* f.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-local"),
      threadId: ThreadId.make("local"),
      projectId,
      title: "T3 work",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
    });
    const synced = yield* Effect.result(
      f.engine.dispatch({
        type: "thread.external-history.sync",
        commandId: CommandId.make("try-sync-local"),
        threadId: ThreadId.make("local"),
        messages: [],
        updatedAt: at,
      }),
    );
    expect(synced._tag).toBe("Failure");
    expect(
      Option.getOrThrow(yield* f.snapshots.getThreadDetailById(ThreadId.make("local"))).messages,
    ).toEqual([]);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("does not duplicate provider sessions owned by T3, including stopped sessions", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const source of ["codex", "claudeAgent"]) {
      yield* f.directory.upsert({
        threadId: ThreadId.make(`owned-${source}`),
        provider: ProviderDriverKind.make(source),
        providerInstanceId: ProviderInstanceId.make(source),
        status: "stopped",
        runtimeMode: "full-access",
        resumeCursor:
          source === "codex" ? { threadId: sessionId(source) } : { resume: sessionId(source) },
      });
    }
    yield* (yield* f.makeSync).sweep;
    expect((yield* f.snapshots.getShellSnapshot()).threads).toEqual([]);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("respects archive and delete across restarts and refreshes after unarchive", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* (yield* f.makeSync).sweep;
    yield* f.engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId: externalId("codex"),
    });
    yield* f.engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId: externalId("claudeAgent"),
    });
    yield* (yield* f.makeSync).sweep;
    expect((yield* f.snapshots.getShellSnapshot()).threads).toEqual([]);
    expect(
      Option.getOrThrow(yield* f.repository.getById({ threadId: externalId("claudeAgent") }))
        .deletedAt,
    ).not.toBeNull();
    yield* f.engine.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive"),
      threadId: externalId("codex"),
    });
    f.setThreads([
      {
        ...transcript("codex"),
        messages: [{ role: "user", text: "changed while archived", createdAt: at }],
      },
    ]);
    yield* (yield* f.makeSync).sweep;
    expect(
      Option.getOrThrow(yield* f.snapshots.getThreadDetailById(externalId("codex"))).messages[0]
        ?.text,
    ).toBe("changed while archived");
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

for (const source of ["codex", "claudeAgent"] as const) {
  it.effect(`takes over only the selected ${source} conversation and enables sending`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* (yield* f.makeSync).sweep;
      const result = yield* importRecentAgentThreads({
        projectId,
        takeOverThreadId: externalId(source),
      }).pipe(Effect.provideService(AgentSessionScanner.AgentSessionScanner, f.scanner));
      expect(result.threadId).toBe(`import:${source}:${sessionId(source)}`);
      const threadId = result.threadId!;
      const active = Option.getOrThrow(yield* f.snapshots.getThreadDetailById(threadId));
      expect(active.messages.map((m) => m.text)).toEqual(["hello", "hi"]);
      expect(active.settledOverride).toBe("active");
      const binding = Option.getOrThrow(yield* f.directory.getBinding(threadId));
      expect(binding.status).toBe("stopped");
      expect(binding.resumeCursor).toMatchObject(
        source === "codex" ? { threadId: sessionId(source) } : { resume: sessionId(source) },
      );
      const otherSource = source === "codex" ? "claudeAgent" : "codex";
      expect(
        Option.isNone(
          yield* f.directory.getBinding(
            ThreadId.make(`import:${otherSource}:${sessionId(otherSource)}`),
          ),
        ),
      ).toBe(true);
      expect(
        Option.getOrThrow(yield* f.repository.getById({ threadId: externalId(source) })).archivedAt,
      ).not.toBeNull();
      const beforeRefresh = yield* f.engine.latestSequence;
      yield* (yield* f.makeSync).sweep;
      expect(yield* f.engine.latestSequence).toBe(beforeRefresh);
      yield* f.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("continue"),
        threadId,
        message: {
          messageId: MessageId.make("followup"),
          role: "user",
          text: "continue here",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-09-30T10:02:00.000Z",
      });
      expect(
        Option.getOrThrow(yield* f.snapshots.getThreadDetailById(threadId)).messages.at(-1)?.text,
      ).toBe("continue here");
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
  );
}

it.effect("leaves the mirror available when takeover cannot read the source history", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* (yield* f.makeSync).sweep;
    f.setThreads([]);
    const result = yield* Effect.result(
      importRecentAgentThreads({ projectId, takeOverThreadId: externalId("codex") }).pipe(
        Effect.provideService(AgentSessionScanner.AgentSessionScanner, f.scanner),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(
      Option.getOrThrow(yield* f.repository.getById({ threadId: externalId("codex") })).archivedAt,
    ).toBeNull();
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("retires an existing mirror when a provider session becomes owned by T3", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sync = yield* f.makeSync;
    yield* sync.sweep;
    yield* f.directory.upsert({
      threadId: ThreadId.make("new-owner"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "full-access",
      resumeCursor: { threadId: sessionId("codex") },
    });
    yield* sync.sweep;
    expect(
      Option.getOrThrow(yield* f.repository.getById({ threadId: externalId("codex") })).archivedAt,
    ).not.toBeNull();
    expect((yield* f.snapshots.getShellSnapshot()).threads.map((thread) => thread.id)).toEqual([
      externalId("claudeAgent"),
    ]);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("rejects a discovery that raced with deletion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* (yield* f.makeSync).sweep;
    const threadId = externalId("codex");
    yield* f.engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-race"),
      threadId,
    });
    const result = yield* Effect.result(
      f.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("rediscover-race"),
        threadId,
        projectId,
        title: "External conversation",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: at,
        historyImport: true,
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(Option.getOrThrow(yield* f.repository.getById({ threadId })).deletedAt).not.toBeNull();
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect(
  "discovery adds nothing; only selected conversations refresh and selection survives restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ externalSessionThreadIds: [] });
      const sync = yield* f.makeSync;
      yield* sync.sweep;
      expect((yield* f.snapshots.getShellSnapshot()).threads).toHaveLength(0);
      const scan = yield* sync.manage({});
      expect(scan.candidates).toHaveLength(2);
      expect(scan.candidates.every((c) => !c.tracked)).toBe(true);
      expect((yield* f.snapshots.getShellSnapshot()).threads).toHaveLength(0);
      yield* sync.manage({ threadIds: [externalId("codex")] });
      expect((yield* f.snapshots.getShellSnapshot()).threads.map((t) => t.id)).toEqual([
        externalId("codex"),
      ]);
      const restarted = yield* f.makeSync;
      yield* restarted.sweep;
      expect(
        (yield* restarted.manage({})).candidates.filter((c) => c.tracked).map((c) => c.threadId),
      ).toEqual([externalId("codex")]);
      yield* restarted.manage({ threadIds: [] });
      expect((yield* settings.getSettings).externalSessionThreadIds).toEqual([]);
      expect((yield* f.snapshots.getShellSnapshot()).threads).toHaveLength(0);
      yield* restarted.sweep;
      expect((yield* f.snapshots.getShellSnapshot()).threads).toHaveLength(0);
      yield* restarted.manage({ threadIds: [externalId("codex")] });
      expect((yield* f.snapshots.getShellSnapshot()).threads).toHaveLength(1);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("archives old automatic previews without touching ordinary T3 threads", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sync = yield* f.makeSync;
    yield* sync.sweep;
    yield* (yield* ServerSettingsService).updateSettings({ externalSessionThreadIds: [] });
    yield* f.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("ordinary"),
      threadId: ThreadId.make("ordinary"),
      projectId,
      title: "T3 conversation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
    });
    yield* sync.sweep;
    expect((yield* f.snapshots.getShellSnapshot()).threads.map((t) => t.id)).toEqual(["ordinary"]);
    expect((yield* sync.manage({})).candidates.every((c) => !c.tracked)).toBe(true);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("rejects unknown selections without changing saved tracking", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sync = yield* f.makeSync;
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({ externalSessionThreadIds: [] });
    const result = yield* Effect.result(
      sync.manage({ threadIds: [ThreadId.make("external:codex:codex:unknown")] }),
    );
    expect(result._tag).toBe("Failure");
    expect((yield* settings.getSettings).externalSessionThreadIds).toEqual([]);
    expect((yield* f.snapshots.getShellSnapshot()).threads).toHaveLength(0);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect(
  "hides conversations already owned by T3 from the picker, even before the next sweep",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sync = yield* f.makeSync;
      yield* sync.sweep;
      yield* f.directory.upsert({
        threadId: ThreadId.make("owned-codex"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        resumeCursor: { threadId: sessionId("codex") },
        status: "stopped",
        runtimeMode: "full-access",
      });
      expect((yield* sync.manage({})).candidates.map((c) => c.threadId)).toEqual([
        externalId("claudeAgent"),
      ]);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect(
  "discovers conversations outside existing projects and adds a project only when selected",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* (yield* ServerSettingsService).updateSettings({ externalSessionThreadIds: [] });
      const workspaceRoot = "/tmp/another-project";
      const scanner = AgentSessionScanner.AgentSessionScanner.of({
        ...f.scanner,
        scan: Effect.succeed({
          scannedAt: at,
          candidates: [
            {
              path: workspaceRoot,
              title: "Another project",
              sources: ["codex"],
              threadCount: 1,
              lastActiveAt: at,
              alreadyImported: false,
            },
          ],
        }),
        recentThreads: (root, completed, background) =>
          root === workspaceRoot
            ? f.scanner
                .recentThreads("/tmp/external-project", completed, background)
                .pipe(
                  Stream.filter(
                    (entry) => entry._tag === "Importable" && entry.thread.source === "codex",
                  ),
                )
            : Stream.empty,
      });
      const sync = yield* ExternalSessionSync.make.pipe(
        Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
      );
      const scan = yield* sync.manage({});
      expect(scan.candidates).toHaveLength(1);
      expect((yield* f.snapshots.getShellSnapshot()).projects).toHaveLength(1);
      yield* sync.manage({ threadIds: [externalId("codex")] });
      const shell = yield* f.snapshots.getShellSnapshot();
      expect(shell.projects).toHaveLength(2);
      const project = shell.projects.find((project) => project.workspaceRoot === workspaceRoot);
      expect(shell.threads[0]?.projectId).toBe(project?.id);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ProjectService from "./ProjectService.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ExternalSessionSync from "./ExternalSessionSync.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const at = "2026-10-03T00:00:00.000Z";
const now = DateTime.makeUnsafe(at);
const projectId = ProjectId.make("external-project");
const threadId = ThreadId.make("external:codex:codex:native-session");
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/tmp/external-project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
};
const initialTranscript: AgentSessionScanner.AgentSessionThread = {
  source: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "native-session",
  title: "External conversation",
  model: null,
  createdAt: at,
  updatedAt: at,
  messages: [
    { role: "user", text: "hello", createdAt: at },
    { role: "assistant", text: "hi", createdAt: at },
  ],
};
const testLayer = Layer.mergeAll(
  ProjectionStore.layer,
  ProviderSessionRuntime.layer,
  ServerSettingsService.layerTest({ externalSessionThreadIds: [] }),
).pipe(Layer.provide(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  let transcript = initialTranscript;
  let projects = [project];
  let eventCount = 0;
  const write = (event: OrchestrationV2DomainEvent) =>
    store.apply(event).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          eventCount++;
        }),
      ),
    );
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.sync(() => ({
      scannedAt: at,
      candidates: [
        {
          path: project.workspaceRoot,
          title: project.title,
          ...(projects[0] ? { projectId: projects[0].id } : {}),
          sources: ["codex" as const],
          threadCount: 1,
          lastActiveAt: at,
          alreadyImported: projects.length > 0,
        },
      ],
    })),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        thread: transcript,
        source: {
          provider: "codex",
          providerInstanceId: transcript.providerInstanceId,
          providerSessionId: transcript.providerSessionId,
          filePath: "/tmp/codex.jsonl",
          size: 100,
          mtimeMs: 1,
          device: 1,
          inode: 1,
          birthtimeMs: 0,
        },
      }),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
    Layer.mock(ProjectService.ProjectService)({
      listShells: () => Effect.sync(() => projects),
      getById: (id) =>
        Effect.sync(() => Option.fromUndefinedOr(projects.find((p) => p.id === id)) as never),
      create: (input) =>
        Effect.sync(() => {
          const created = { ...project, id: input.projectId };
          projects.push(created);
          return created as never;
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getShellSnapshot: () => store.getShellSnapshot().pipe(Effect.orDie),
      getThreadRecords: (id, fields) =>
        store
          .getThreadRecords(id, fields)
          .pipe(
            Effect.mapError(() => new Orchestrator.OrchestratorProjectionError({ threadId: id })),
          ),
      dispatch: (command) =>
        Effect.gen(function* () {
          let thread: OrchestrationV2AppThread;
          if (command.type === "thread.create") {
            thread = {
              ...command,
              id: command.threadId,
              providerInstanceId: command.modelSelection.instanceId,
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: command.threadId,
              },
              forkedFrom: null,
              linkedPullRequest: null,
              branchPullRequest: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            };
            yield* write({
              id: EventId.make(command.commandId),
              threadId: thread.id,
              type: "thread.created",
              occurredAt: now,
              payload: thread,
            });
          } else if (command.type === "thread.archive" || command.type === "thread.unarchive") {
            thread = yield* store.getThread(command.threadId);
            yield* write({
              id: EventId.make(command.commandId),
              threadId: thread.id,
              type: command.type === "thread.archive" ? "thread.archived" : "thread.unarchived",
              occurredAt: now,
              payload: { ...thread, archivedAt: command.type === "thread.archive" ? now : null },
            });
          } else throw new Error(`Unexpected command ${command.type}`);
          return { events: [], effects: [] } as never;
        }).pipe(Effect.orDie),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      write: (input) => Effect.forEach(input.events, write).pipe(Effect.as([]), Effect.orDie),
    }),
  );
  return {
    store,
    runtimes,
    scanner,
    makeSync: ExternalSessionSync.make.pipe(Effect.provide(layer)),
    setTranscript: (value: typeof transcript) => {
      transcript = value;
    },
    removeProjects: () => {
      projects = [];
    },
    projects: () => projects,
    eventCount: () => eventCount,
  };
});

it.effect("discovers without importing, tracks only selected chats, and remembers selection", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sync = yield* f.makeSync;
    expect((yield* sync.manage({})).candidates.map((c) => c.tracked)).toEqual([false]);
    yield* sync.sweep;
    expect((yield* f.store.getShellSnapshot()).threads).toHaveLength(0);
    yield* sync.manage({ threadIds: [threadId] });
    expect(
      (yield* f.store.getThreadRecords(threadId, ["messages"])).messages.map((m) => m.text),
    ).toEqual(["hello", "hi"]);
    expect(yield* f.runtimes.list()).toEqual([]);
    expect((yield* sync.manage({})).candidates[0]?.tracked).toBe(true);
    yield* sync.manage({ threadIds: [] });
    expect((yield* f.store.getThread(threadId)).archivedAt).not.toBeNull();
    yield* sync.manage({ threadIds: [threadId] });
    expect((yield* f.store.getThread(threadId)).archivedAt).toBeNull();
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("replaces edited history and does not rebroadcast identical previews after restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sync = yield* f.makeSync;
    yield* sync.manage({ threadIds: [threadId] });
    const before = f.eventCount();
    yield* sync.sweep;
    yield* (yield* f.makeSync).sweep;
    expect(f.eventCount()).toBe(before);
    f.setTranscript({
      ...initialTranscript,
      messages: [{ role: "user", text: "edited", createdAt: at }],
    });
    yield* sync.sweep;
    const record = yield* f.store.getThreadRecords(threadId, ["messages", "turnItems"]);
    expect(record.messages.map((m) => m.text)).toEqual(["edited"]);
    expect(record.turnItems).toHaveLength(1);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("creates a missing project only after selection and rejects unavailable selections", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.removeProjects();
    const sync = yield* f.makeSync;
    const { candidates } = yield* sync.manage({});
    expect(candidates).toHaveLength(1);
    expect(f.projects()).toEqual([]);
    expect(
      yield* Effect.result(sync.manage({ threadIds: [ThreadId.make("missing")] })),
    ).toMatchObject({ _tag: "Failure" });
    yield* sync.manage({ threadIds: [threadId] });
    expect(f.projects()).toHaveLength(1);
    expect((yield* f.store.getThread(threadId)).projectId).toBe(f.projects()[0]?.id);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("hides a native session once T3 owns its resume cursor", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sync = yield* f.makeSync;
    yield* sync.manage({ threadIds: [threadId] });
    yield* f.runtimes.upsert({
      threadId: ThreadId.make("owned"),
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      adapterKey: "codex",
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: at,
      resumeCursor: { threadId: "native-session" },
      runtimePayload: {},
    });
    expect((yield* sync.manage({})).candidates).toEqual([]);
    yield* sync.sweep;
    expect((yield* f.store.getThread(threadId)).archivedAt).not.toBeNull();
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

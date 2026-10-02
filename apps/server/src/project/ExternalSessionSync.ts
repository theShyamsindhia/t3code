import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ExternalSessionsError,
  externalSessionSource,
  externalSessionIdentity,
  type ExternalSessionCandidate,
  type ExternalSessionsInput,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_MODEL,
  ProviderDriverKind,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type AgentSessionImportSource,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { forkParked } from "../serverActivation.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const isExternalSessionsError = Schema.is(ExternalSessionsError);

const decodeResumeCursor = Schema.decodeUnknownOption(
  Schema.Struct({
    threadId: Schema.optional(Schema.String),
    resume: Schema.optional(Schema.String),
  }),
);

/** One bounded sweep; the cache belongs to this server, never to a browser connection. */
export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const threadRepository = yield* ProjectionThreadRepository;
  let completed = new Map<string, AgentSessionImportSource>();

  const run = Effect.fnUntraced(function* (discover: boolean) {
    const selected = new Set((yield* settings.getSettings).externalSessionThreadIds);
    const candidates = new Map<ThreadId, ExternalSessionCandidate>();
    const shell = yield* snapshots.getShellSnapshot();
    const projects = shell.projects.map(({ id, title, workspaceRoot }) => ({
      id,
      title,
      workspaceRoot,
    }));
    if (!discover) {
      // Old automatic previews and unchecked conversations leave the sidebar.
      for (const thread of shell.threads) {
        if (externalSessionSource(thread.id) && !selected.has(thread.id)) {
          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId: thread.id,
          });
        }
      }
      if (selected.size === 0) {
        completed.clear();
        return [];
      }
    }
    // Refresh the scanner's directory listing so newly created sessions are discovered too.
    const discovery = yield* scanner.scan;
    if (discover)
      for (const candidate of discovery.candidates) {
        if (projects.some((project) => project.workspaceRoot === candidate.path)) continue;
        projects.push({
          id:
            candidate.projectId ??
            ProjectId.make(
              `external-project:${NodeCrypto.createHash("sha256").update(candidate.path).digest("hex")}`,
            ),
          title: candidate.title,
          workspaceRoot: candidate.path,
        });
      }
    const selectedSessions = [...selected].flatMap((id) => {
      const identity = externalSessionIdentity(id);
      return identity ? [`${identity.providerInstanceId}\0${identity.providerSessionId}`] : [];
    });
    const bindings = yield* directory.listBindings();
    const ownedSessions = new Set(
      bindings.flatMap((binding) => {
        const cursor = Option.getOrNull(decodeResumeCursor(binding.resumeCursor));
        const sessionId = binding.provider === "codex" ? cursor?.threadId : cursor?.resume;
        return sessionId && binding.providerInstanceId
          ? [`${binding.providerInstanceId}\0${sessionId}`]
          : [];
      }),
    );
    const nextCompleted = new Map<string, AgentSessionImportSource>();
    for (const project of projects) {
      yield* Stream.runForEach(
        scanner.recentThreads(
          project.workspaceRoot,
          discover ? [] : [...completed.values()],
          discover ? "discover" : true,
          discover ? undefined : selectedSessions,
        ),
        (outcome) =>
          Effect.gen(function* () {
            if (outcome._tag === "Skipped") return;
            const source = outcome.source;
            const fileKey = `${source.providerInstanceId}\0${source.filePath}`;
            const sessionKey = `${source.providerInstanceId}\0${source.providerSessionId}`;
            const threadId = ThreadId.make(
              `external:${source.provider}:${encodeURIComponent(source.providerInstanceId)}:${encodeURIComponent(source.providerSessionId)}`,
            );
            const imported = yield* threadRepository.getById({
              threadId: ThreadId.make(
                `import:${source.providerInstanceId}:${source.providerSessionId}`,
              ),
            });
            if (discover && (ownedSessions.has(sessionKey) || Option.isSome(imported))) return;
            if (!discover && !selected.has(threadId)) return;
            // Ownership can change even when the transcript file did not change.
            if (ownedSessions.has(sessionKey) || Option.isSome(imported)) {
              const mirror = yield* threadRepository.getById({ threadId });
              if (
                Option.isSome(mirror) &&
                mirror.value.archivedAt === null &&
                mirror.value.deletedAt === null
              ) {
                yield* engine.dispatch({
                  type: "thread.archive",
                  commandId: CommandId.make(yield* crypto.randomUUIDv4),
                  threadId,
                });
              }
              nextCompleted.set(fileKey, source);
              return;
            }
            if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
              nextCompleted.set(fileKey, source);
              return;
            }
            const transcript = outcome.thread;
            const row = yield* threadRepository.getById({ threadId });
            if (Option.isSome(row) && row.value.deletedAt !== null) return;
            if (discover) {
              candidates.set(threadId, {
                threadId,
                projectId: project.id,
                projectTitle: project.title,
                workspaceRoot: project.workspaceRoot,
                title: transcript.title,
                source: transcript.source,
                updatedAt: transcript.updatedAt,
                tracked:
                  selected.has(threadId) && (Option.isNone(row) || row.value.archivedAt === null),
              });
              return;
            }
            if (Option.isSome(row) && row.value.archivedAt !== null) return;
            const existing = yield* snapshots.getThreadDetailById(threadId);
            if (
              Option.isSome(existing) &&
              (existing.value.projectId !== project.id ||
                existing.value.archivedAt !== null ||
                existing.value.deletedAt !== null ||
                existing.value.session !== null ||
                existing.value.latestTurn !== null)
            )
              return;

            if (Option.isNone(existing)) {
              yield* engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                threadId,
                projectId: project.id,
                title: transcript.title,
                modelSelection: {
                  instanceId: transcript.providerInstanceId,
                  model:
                    transcript.model ??
                    DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(transcript.source)] ??
                    DEFAULT_MODEL,
                },
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                branch: null,
                worktreePath: null,
                createdAt: transcript.createdAt,
                historyImport: true,
              });
            }
            const messages = transcript.messages.map((message, index) => {
              const digest = NodeCrypto.createHash("sha256")
                .update(`${message.role}\0${message.createdAt}\0${message.text}`)
                .digest("hex");
              return {
                ...message,
                id: MessageId.make(
                  `import:${threadId}:${String(index).padStart(6, "0")}:${digest}`,
                ),
                turnId: null,
                streaming: false,
                updatedAt: message.createdAt,
              };
            });
            // Tool-only changes and restarts should not rebroadcast identical history.
            if (
              Option.isNone(existing) ||
              existing.value.messages.length !== messages.length ||
              existing.value.messages.some((message, index) => message.id !== messages[index]?.id)
            ) {
              yield* engine.dispatch({
                type: "thread.external-history.sync",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                threadId,
                messages,
                updatedAt: transcript.updatedAt,
              });
            }
            nextCompleted.set(fileKey, source);
          }).pipe(
            Effect.catch((cause) =>
              discover
                ? Effect.fail(cause)
                : Effect.logWarning("Could not refresh external conversation", { cause }),
            ),
          ),
      ).pipe(
        Effect.catch((cause) =>
          discover
            ? Effect.fail(cause)
            : Effect.logWarning("Could not scan external conversations", {
                projectId: project.id,
                cause,
              }),
        ),
      );
    }
    if (!discover) completed = nextCompleted;
    // Keep selected conversations removable even when their source is temporarily unavailable.
    if (discover)
      for (const threadId of selected) {
        if (candidates.has(threadId)) continue;
        const row = yield* threadRepository.getById({ threadId });
        const identity = externalSessionIdentity(threadId);
        if (
          Option.isNone(row) ||
          row.value.deletedAt !== null ||
          row.value.archivedAt !== null ||
          !identity
        )
          continue;
        if (
          ownedSessions.has(`${identity.providerInstanceId}\0${identity.providerSessionId}`) ||
          Option.isSome(
            yield* threadRepository.getById({
              threadId: ThreadId.make(
                `import:${identity.providerInstanceId}:${identity.providerSessionId}`,
              ),
            }),
          )
        )
          continue;
        candidates.set(threadId, {
          threadId,
          projectId: row.value.projectId,
          projectTitle: projects.find((p) => p.id === row.value.projectId)?.title ?? "Project",
          workspaceRoot: projects.find((p) => p.id === row.value.projectId)?.workspaceRoot ?? "",
          title: row.value.title,
          source: identity.provider === "codex" ? "codex" : "claudeAgent",
          updatedAt: row.value.updatedAt,
          tracked: true,
        });
      }
    return [...candidates.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
  const sweep = lock.withPermits(1)(run(false));
  const manage = (input: typeof ExternalSessionsInput.Type) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const candidates = yield* run(true);
          if (input.threadIds === undefined) return { candidates };
          const available = new Set(candidates.map((candidate) => candidate.threadId));
          if (input.threadIds.some((id) => !available.has(id))) {
            return yield* new ExternalSessionsError({
              detail: "A conversation is no longer available. Scan again before saving.",
            });
          }
          const threadIds = [...new Set(input.threadIds)];
          for (const candidate of candidates) {
            if (!threadIds.includes(candidate.threadId)) continue;
            if (Option.isNone(yield* snapshots.getProjectShellById(candidate.projectId))) {
              yield* engine.dispatch({
                type: "project.create",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                projectId: candidate.projectId,
                title: candidate.projectTitle,
                workspaceRoot: candidate.workspaceRoot,
                defaultModelSelection: null,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              });
            }
          }
          yield* settings.updateSettings({ externalSessionThreadIds: threadIds });
          for (const threadId of threadIds) {
            const row = yield* threadRepository.getById({ threadId });
            if (
              Option.isSome(row) &&
              row.value.archivedAt !== null &&
              row.value.deletedAt === null
            ) {
              yield* engine.dispatch({
                type: "thread.unarchive",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                threadId,
              });
            }
          }
          completed.clear();
          yield* run(false);
          return {
            candidates: candidates.map((candidate) => ({
              ...candidate,
              tracked: threadIds.includes(candidate.threadId),
            })),
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isExternalSessionsError(cause)
            ? cause
            : new ExternalSessionsError({
                detail: "Could not sync conversations. Please try again.",
              }),
        ),
      );
  return { sweep, manage };
});

export class ExternalSessionSync extends Context.Service<
  ExternalSessionSync,
  Effect.Success<typeof make>
>()("t3/project/ExternalSessionSync") {}

export const layer = Layer.effect(
  ExternalSessionSync,
  Effect.gen(function* () {
    const service = yield* make;
    const { sweep } = service;
    yield* forkParked(
      sweep.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("External conversation refresh failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("1 minute")),
      ),
    );
    return service;
  }),
).pipe(Layer.provide(AgentSessionScanner.layer));

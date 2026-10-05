import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { present, presentWidget } from "./InteractionMcpService.ts";

const threadId = ThreadId.make("interaction-caller");
const caller = {
  ...v2PullRequestThread({
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Test",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
  }),
  activeRunId: RunId.make("run"),
};
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId,
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const input = {
  title: "Compare",
  prompt: "Which fits?",
  groups: [{ id: "keep", label: "Keep" }],
  items: ["a", "b"].map((id) => ({ id, label: id, detail: "", groupId: null, emphasis: false })),
};
const layer = (thread: OrchestrationV2ThreadShell | null) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(thread),
  });

it.effect("lets a live agent present in plan mode without starting work or waiting for input", () =>
  Effect.gen(function* () {
    for (const invoke of [
      () => present(input),
      () =>
        presentWidget({
          title: "Compare",
          description: "Choose",
          html: "<input type=range>",
          height: 200,
        }),
    ]) {
      const result = yield* invoke().pipe(
        Effect.provide(layer(caller)),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      );
      expect(result.title).toBe("Compare");
      expect(result.message).toContain("Finish your turn");
    }
  }),
);

it.effect("rejects missing, archived, stopped, and replaced callers", () =>
  Effect.gen(function* () {
    for (const thread of [
      null,
      { ...caller, archivedAt: DateTime.makeUnsafe("2026-10-04T00:00:00Z") },
      { ...caller, activeRunId: null },
      { ...caller, providerInstanceId: ProviderInstanceId.make("other") },
    ]) {
      for (const invoke of [
        () => present(input),
        () =>
          presentWidget({
            title: "Compare",
            description: "Choose",
            html: "<input type=range>",
            height: 200,
          }),
      ]) {
        const error = yield* invoke().pipe(
          Effect.provide(layer(thread)),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.flip,
        );
        expect(error.code).toBe(thread === null ? "thread_not_found" : "parent_not_active");
      }
    }
  }),
);

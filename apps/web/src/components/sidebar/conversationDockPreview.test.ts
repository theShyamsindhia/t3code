import {
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { conversationDockPreview, dockPreviewText } from "./conversationDockPreview";

const now = DateTime.makeUnsafe("2026-10-07T00:00:00Z");
const runId = RunId.make("current");
const shell: Parameters<typeof conversationDockPreview>[0] = {
  activeRunId: null,
  latestRunId: runId,
  pendingRuntimeRequest: null,
  status: "completed",
};
const base = {
  id: TurnItemId.make("item"),
  threadId: ThreadId.make("thread"),
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
function reply(text: string, ordinal = 1): OrchestrationV2TurnItem {
  return {
    ...base,
    id: TurnItemId.make(`reply-${ordinal}`),
    ordinal,
    type: "assistant_message",
    messageId: MessageId.make(`message-${ordinal}`),
    text,
    streaming: false,
  };
}
function detail(...items: OrchestrationV2TurnItem[]) {
  return {
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
  };
}

describe("dock previews", () => {
  it("shows the final reply rather than earlier commentary or the user's prompt", () => {
    const preview = conversationDockPreview(
      shell,
      detail(reply("I will check", 1), reply("**Fixed** the bug. Tests pass.", 2)),
    );
    expect(preview).toEqual({ label: "Last reply", text: "Fixed the bug. Tests pass." });
  });

  it("never presents the previous turn as work happening now", () => {
    const old = { ...reply("Shipped the changes."), runId: RunId.make("previous") };
    expect(
      conversationDockPreview({ ...shell, status: "starting", activeRunId: runId }, detail(old)),
    ).toEqual({ label: "Working", text: "Waiting for the next update…" });
    expect(conversationDockPreview(shell, detail(old)).text).toBe("No reply in this turn yet.");
  });

  it("uses the newest real activity while running, without including command output", () => {
    const command: OrchestrationV2TurnItem = {
      ...base,
      type: "command_execution",
      input: "vp test run",
      output: "raw output",
      status: "running",
      updatedAt: DateTime.makeUnsafe("2026-10-07T00:00:01Z"),
    };
    expect(
      conversationDockPreview(
        { ...shell, status: "running", activeRunId: runId },
        detail(reply("Checking the fix"), command),
      ),
    ).toEqual({ label: "Working", text: "Running vp test run" });
  });

  it("does not call a streamed partial answer a conclusion", () => {
    const partial = { ...reply("Not finished"), streaming: true };
    expect(conversationDockPreview(shell, detail(partial)).text).toBe("No reply in this turn yet.");
  });

  it("shows the current question ahead of activity and ignores an older request", () => {
    const id = RuntimeRequestId.make("question");
    const item: OrchestrationV2TurnItem = {
      ...base,
      type: "user_input_request",
      requestId: id,
      questions: [
        { id: "q", header: "Choice", question: "Which project should I use?", options: [] },
      ],
    };
    expect(
      conversationDockPreview(
        {
          ...shell,
          pendingRuntimeRequest: { id, kind: "user_input", createdAt: now },
          status: "running",
        },
        detail(item, reply("Working", 3)),
      ),
    ).toEqual({ label: "Needs your input", text: "Which project should I use?" });
    expect(
      conversationDockPreview(
        {
          ...shell,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("other"),
            kind: "user_input",
            createdAt: now,
          },
        },
        detail(item),
      ).text,
    ).toBe("Open this chat to respond.");
  });

  it("shows a failure instead of implying the last reply was successful", () => {
    expect(
      conversationDockPreview(
        { ...shell, status: "failed", lastError: "Provider connection closed" },
        detail(reply("Starting…")),
      ),
    ).toEqual({ label: "Failed", text: "Provider connection closed" });
  });

  it("keeps a pending subagent distinct from a completed turn with a dev server running", () => {
    expect(
      conversationDockPreview(
        {
          ...shell,
          pendingBackgroundTasks: [
            { taskId: "agent", kind: "subagent", description: "Reviewing the fix" },
          ],
        },
        detail(reply("Waiting for review")),
      ),
    ).toEqual({ label: "Waiting on background work", text: "Reviewing the fix" });
    expect(
      conversationDockPreview(
        { ...shell, pendingBackgroundTasks: [{ taskId: "dev", kind: "command" }] },
        detail(reply("Ready to test")),
      ).label,
    ).toBe("Last reply");
  });

  it("distinguishes loading, stopped and queued chats", () => {
    expect(conversationDockPreview(shell, null).text).toBe("Loading last reply…");
    expect(
      conversationDockPreview({ ...shell, status: "interrupted" }, detail(reply("Partial result")))
        .label,
    ).toBe("Stopped");
    expect(conversationDockPreview({ ...shell, status: "queued" }, detail()).label).toBe("Queued");
  });

  it("bounds previews and removes common markdown without rendering HTML", () => {
    expect(
      dockPreviewText("## Done\n- **Tests pass**. See [details](https://example.com).\n`ok`"),
    ).toBe("Done Tests pass. See details. ok");
    expect(dockPreviewText("a".repeat(50_000))).toHaveLength(240);
    expect(dockPreviewText("<script>text</script>")).toBe("<script>text</script>");
    expect(dockPreviewText("Running `ls *_test.ts`")).toBe("Running ls *_test.ts");
  });
});

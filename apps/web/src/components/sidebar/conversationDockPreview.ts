import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

export function dockPreviewText(text: string): string {
  const plain = text
    .slice(0, 2_000)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 240 ? `${plain.slice(0, 239).trimEnd()}…` : plain;
}

function activityText(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "assistant_message":
      return item.text;
    case "command_execution":
      return item.title || `${item.status === "completed" ? "Ran" : "Running"} ${item.input}`;
    case "file_change":
      return (
        item.title || `${item.status === "completed" ? "Changed" : "Editing"} ${item.fileName}`
      );
    case "dynamic_tool":
      return item.title || item.toolName || "Using a tool";
    case "file_search":
      return item.title || `Searching files${item.pattern ? ` for ${item.pattern}` : ""}`;
    case "web_search":
      return (
        item.title ||
        `Searching the web${item.patterns?.length ? ` for ${item.patterns.join(", ")}` : ""}`
      );
    case "subagent":
      return item.progress || item.title || "Working with an agent";
    case "proposed_plan":
      return item.markdown;
    default:
      return "";
  }
}

/** Uses visible items from the current run, never another turn's conclusion. */
export function conversationDockPreview(
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "activeRunId"
    | "latestRunId"
    | "pendingRuntimeRequest"
    | "activityRunStatus"
    | "status"
    | "lastError"
    | "pendingBackgroundTasks"
  >,
  projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems"> | null,
): { label: string; text: string } {
  const runId = shell.activeRunId ?? shell.latestRunId;
  const items = (projection?.visibleTurnItems ?? [])
    .map((row) => row.item)
    .filter((item) => item.runId === runId)
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
        b.ordinal - a.ordinal,
    );
  const request = shell.pendingRuntimeRequest;
  if (request && request.kind !== "auth_refresh") {
    const item = items.find((item) => "requestId" in item && item.requestId === request.id);
    const text =
      item?.type === "user_input_request"
        ? item.questions.map((question) => question.question).join(" ")
        : item?.type === "approval_request"
          ? item.prompt
          : undefined;
    return {
      label: request.kind === "user_input" ? "Needs your input" : "Needs approval",
      text: dockPreviewText(text || "Open this chat to respond."),
    };
  }
  const status = shell.activityRunStatus ?? shell.status;
  if (status === "failed") {
    return {
      label: "Failed",
      text: dockPreviewText(shell.lastError || "Open this chat to see what went wrong."),
    };
  }
  const working = ["preparing", "starting", "running", "waiting"].includes(status);
  if (working) {
    const text = items.map(activityText).find((text) => text.trim());
    return {
      label: "Working",
      text: dockPreviewText(
        text || (projection ? "Waiting for the next update…" : "Loading latest activity…"),
      ),
    };
  }
  if (status === "completed" && backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])) {
    const tasks = shell.pendingBackgroundTasks?.filter((task) => task.kind !== "command");
    return {
      label: "Waiting on background work",
      text: dockPreviewText(
        tasks
          ?.map((task) => task.description)
          .filter(Boolean)
          .join(" · ") || "The agent will continue when background work finishes.",
      ),
    };
  }
  const reply = items.find(
    (item) => item.type === "assistant_message" && !item.streaming && item.text.trim(),
  );
  return {
    label:
      status === "interrupted" || status === "cancelled"
        ? "Stopped"
        : status === "queued"
          ? "Queued"
          : "Last reply",
    text:
      reply?.type === "assistant_message"
        ? dockPreviewText(reply.text)
        : projection
          ? "No reply in this turn yet."
          : "Loading last reply…",
  };
}

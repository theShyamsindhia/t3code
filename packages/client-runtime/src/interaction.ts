import {
  ChatWidgetPresentation,
  InteractionPresentation,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveT3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";
import { t3ToolResultIndicatesFailure } from "./t3ToolSummary.ts";

const decode = Schema.decodeUnknownOption(InteractionPresentation);
const decodeWidget = Schema.decodeUnknownOption(ChatWidgetPresentation);

/** Only successful, validated tool calls can become executable widget surfaces. */
export function chatWidgetPresentation(item: OrchestrationV2ProjectedTurnItem["item"]) {
  if (
    item.type !== "dynamic_tool" ||
    item.status !== "completed" ||
    resolveT3McpToolSummaryAction(item.toolName ?? "") !== "widget-present" ||
    t3ToolResultIndicatesFailure(item.output)
  )
    return null;
  let input = item.input;
  try {
    if (typeof input === "string") input = JSON.parse(input);
  } catch {
    return null;
  }
  if (input && typeof input === "object" && "args" in input && "toolName" in input)
    input = input.args;
  const result = decodeWidget(input);
  return Option.isSome(result) ? result.value : null;
}

export function interactionPresentations(rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  return rows.flatMap(({ item, sourceThreadId, sourceItemId }) => {
    if (
      item.type !== "dynamic_tool" ||
      item.status !== "completed" ||
      resolveT3McpToolSummaryAction(item.toolName ?? "") !== "interaction-present" ||
      t3ToolResultIndicatesFailure(item.output)
    )
      return [];
    let input = item.input;
    try {
      if (typeof input === "string") input = JSON.parse(input);
    } catch {
      return [];
    }
    // Cursor retains the MCP argument envelope.
    if (input && typeof input === "object" && "args" in input && "toolName" in input)
      input = input.args;
    const decoded = decode(input);
    return Option.isSome(decoded)
      ? [
          {
            id: `${sourceThreadId}:${sourceItemId}`,
            presentation: decoded.value,
          },
        ]
      : [];
  });
}

export const InteractionDraft = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String.check(Schema.isMaxLength(120)) }),
  ).check(Schema.isMaxLength(6)),
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      groupId: Schema.NullOr(Schema.String),
      note: Schema.String.check(Schema.isMaxLength(1000)),
    }),
  ).check(Schema.isMaxLength(12)),
  note: Schema.String.check(Schema.isMaxLength(2000)),
});
export type InteractionDraft = typeof InteractionDraft.Type;
const decodeDraft = Schema.decodeUnknownOption(InteractionDraft);

export function createInteractionDraft(presentation: InteractionPresentation): InteractionDraft {
  return {
    groups: presentation.groups,
    items: presentation.items.map(({ id, groupId }) => ({ id, groupId, note: "" })),
    note: "",
  };
}

export function restoreInteractionDraft(
  value: unknown,
  presentation: InteractionPresentation,
): InteractionDraft {
  const result = decodeDraft(value);
  if (Option.isNone(result)) return createInteractionDraft(presentation);
  const draft = result.value;
  const ids = new Set(draft.items.map((item) => item.id));
  const groups = new Set(draft.groups.map((group) => group.id));
  return ids.size === presentation.items.length &&
    draft.items.length === ids.size &&
    presentation.items.every((item) => ids.has(item.id)) &&
    groups.size === draft.groups.length &&
    draft.items.every((item) => item.groupId === null || groups.has(item.groupId))
    ? draft
    : createInteractionDraft(presentation);
}

/** Move to the end of a group, or before another item in that group. */
export function moveInteractionItem(
  draft: InteractionDraft,
  id: string,
  groupId: string | null,
  beforeId?: string,
): InteractionDraft {
  const item = draft.items.find((candidate) => candidate.id === id);
  if (
    !item ||
    beforeId === id ||
    (groupId !== null && !draft.groups.some((group) => group.id === groupId))
  )
    return draft;
  const items = draft.items.filter((candidate) => candidate.id !== id);
  const index = beforeId
    ? items.findIndex((candidate) => candidate.id === beforeId && candidate.groupId === groupId)
    : -1;
  items.splice(index < 0 ? items.length : index, 0, { ...item, groupId });
  return { ...draft, items };
}

export function formatInteractionReply(
  presentation: InteractionPresentation,
  draft: InteractionDraft,
): string {
  const labels = new Map(presentation.items.map((item) => [item.id, item.label]));
  const sections = [...draft.groups, { id: null, label: "Unsorted" }].map((group) => {
    const items = draft.items.filter((item) => item.groupId === group.id);
    return `${group.label.trim() || "Untitled group"}:\n${items.length ? items.map((item, index) => `${index + 1}. ${labels.get(item.id)} [${item.id}]${item.note.trim() ? `\n   My note: ${item.note.trim()}` : ""}`).join("\n") : "(empty)"}`;
  });
  return [
    `My response to “${presentation.title}”`,
    presentation.prompt,
    "My arrangement (order within each group is shown below):",
    ...sections,
    ...(draft.note.trim() ? [`My note: ${draft.note.trim()}`] : []),
  ].join("\n\n");
}

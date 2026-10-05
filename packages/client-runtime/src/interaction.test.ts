import { describe, expect, it } from "vite-plus/test";
import {
  ChatWidgetPresentation,
  InteractionPresentation,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  chatWidgetPresentation,
  createInteractionDraft,
  formatInteractionReply,
  interactionPresentations,
  moveInteractionItem,
  restoreInteractionDraft,
} from "./interaction.ts";

const presentation: InteractionPresentation = {
  title: "What feels right?",
  prompt: "Group these directions, and tell me why.",
  groups: [
    { id: "keep", label: "Explore" },
    { id: "avoid", label: "Avoid" },
  ],
  items: [
    { id: "a", label: "Quiet", detail: "Few interruptions", groupId: null, emphasis: false },
    { id: "b", label: "Guided", detail: "Frequent suggestions", groupId: null, emphasis: true },
  ],
};
const now = DateTime.makeUnsafe("2026-10-04T00:00:00Z");
function row(input: unknown = presentation, overrides = {}): OrchestrationV2ProjectedTurnItem {
  const threadId = ThreadId.make("thread");
  const id = TurnItemId.make("call");
  return {
    position: 1,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: id,
    item: {
      id,
      threadId,
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_interaction_present",
      status: "completed",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      title: "Shared space",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      input,
      output: {},
      ...overrides,
    },
  };
}

describe("shared space contract", () => {
  const valid = Schema.is(InteractionPresentation);
  it("rejects duplicate IDs, missing groups, and oversized Unicode inputs", () => {
    expect(valid(presentation)).toBe(true);
    expect(valid({ ...presentation, items: [presentation.items[0], presentation.items[0]] })).toBe(
      false,
    );
    expect(
      valid({ ...presentation, groups: [presentation.groups[0], presentation.groups[0]] }),
    ).toBe(false);
    expect(
      valid({
        ...presentation,
        items: presentation.items.map((item) => ({ ...item, groupId: "absent" })),
      }),
    ).toBe(false);
    expect(
      valid({
        ...presentation,
        items: Array.from({ length: 8 }, (_, index) => ({
          ...presentation.items[0],
          id: String(index),
          detail: "界".repeat(500),
        })),
      }),
    ).toBe(false);
  });
  it("reads successful calls across provider names and envelopes", () => {
    for (const toolName of [
      "t3_interaction_present",
      "mcp__t3-code__t3_interaction_present",
      "T3-code.t3_interaction_present",
    ]) {
      for (const input of [
        presentation,
        JSON.stringify(presentation),
        { toolName, args: presentation },
      ]) {
        expect(interactionPresentations([row(input, { toolName })])[0]?.presentation).toEqual(
          presentation,
        );
      }
    }
  });
  it("ignores unfinished, failed, unrelated, and malformed tool calls", () => {
    for (const overrides of [
      { status: "running" },
      { status: "failed" },
      { output: { isError: true } },
      { output: { _tag: "OrchestratorMcpFailure" } },
      { toolName: "other" },
    ]) {
      expect(interactionPresentations([row(presentation, overrides)])).toEqual([]);
    }
    expect(interactionPresentations([row("{"), row({ truncated: true })])).toEqual([]);
  });
});

describe("arranging a response", () => {
  it("moves and reorders without losing notes or changing the agent's source", () => {
    let draft = createInteractionDraft(presentation);
    draft = { ...draft, items: draft.items.map((item) => ({ ...item, note: `About ${item.id}` })) };
    draft = moveInteractionItem(draft, "a", "keep");
    draft = moveInteractionItem(draft, "b", "keep", "a");
    expect(draft.items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(draft.items[1]?.note).toBe("About a");
    expect(presentation.items[0]?.groupId).toBeNull();
    expect(moveInteractionItem(draft, "a", "missing")).toBe(draft);
    const reply = formatInteractionReply(presentation, draft);
    expect(reply).toContain("Explore:\n1. Guided [b]\n   My note: About b\n2. Quiet [a]");
    expect(reply).toContain("Avoid:\n(empty)");
  });
  it("restores valid drafts but discards corrupt or mismatched history", () => {
    const initial = createInteractionDraft(presentation);
    const draft = moveInteractionItem(initial, "a", "avoid");
    expect(restoreInteractionDraft(JSON.parse(JSON.stringify(draft)), presentation)).toEqual(draft);
    expect(
      restoreInteractionDraft({ ...draft, items: [draft.items[0], draft.items[0]] }, presentation),
    ).toEqual(initial);
    expect(restoreInteractionDraft({ ...draft, groups: [] }, presentation)).toEqual(initial);
    expect(restoreInteractionDraft(null, presentation)).toEqual(initial);
  });
});

describe("inline widgets", () => {
  const widget = {
    title: "Focus",
    description: "Try a different balance",
    html: "<input type='range'>",
    height: 240,
  };
  const valid = Schema.is(ChatWidgetPresentation);
  it("bounds the document in bytes and limits its layout footprint", () => {
    expect(valid(widget)).toBe(true);
    for (const bad of [
      { height: 641 },
      { height: 159 },
      { height: 240.5 },
      { html: "" },
      { html: "界".repeat(2100) },
      { html: "x".repeat(5900), description: "y".repeat(500) },
    ])
      expect(valid({ ...widget, ...bad })).toBe(false);
  });
  it("reads provider envelopes but refuses pending, failed, truncated, and unrelated calls", () => {
    for (const toolName of [
      "t3_widget_present",
      "mcp__t3-code__t3_widget_present",
      "T3-code.t3_widget_present",
    ]) {
      for (const input of [widget, JSON.stringify(widget), { toolName, args: widget }])
        expect(chatWidgetPresentation(row(input, { toolName }).item)).toEqual(widget);
    }
    for (const overrides of [
      { status: "running" },
      { status: "failed" },
      { output: { isError: true } },
      { toolName: "unknown" },
    ])
      expect(
        chatWidgetPresentation(row(widget, { toolName: "t3_widget_present", ...overrides }).item),
      ).toBeNull();
    for (const input of ["{", { truncated: true }, { ...widget, height: 0 }])
      expect(chatWidgetPresentation(row(input, { toolName: "t3_widget_present" }).item)).toBeNull();
  });
});

import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(48));
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

/** Small, declarative presentations travel intact in the existing tool-call history. */
export const InteractionPresentation = Schema.Struct({
  title: Label,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
  groups: Schema.Array(Schema.Struct({ id: Id, label: Label })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4),
  ),
  items: Schema.Array(
    Schema.Struct({
      id: Id,
      label: Label,
      detail: Schema.String.check(Schema.isMaxLength(500)),
      groupId: Schema.NullOr(Id),
      emphasis: Schema.Boolean,
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(12)),
}).check(
  Schema.makeFilter((value) => {
    const groups = new Set(value.groups.map((group) => group.id));
    return (
      (groups.size === value.groups.length &&
        new Set(value.items.map((item) => item.id)).size === value.items.length &&
        value.items.every((item) => item.groupId === null || groups.has(item.groupId)) &&
        // Allow JSON-string escaping and provider envelopes within the 16 KiB wire limit.
        new TextEncoder().encode(JSON.stringify(value)).length <= 6_000) ||
      "Use unique IDs, existing groups, and a presentation under 6 KB."
    );
  }),
);
export type InteractionPresentation = typeof InteractionPresentation.Type;

/** Self-contained widgets share the same bounded, durable tool-call transport. */
export const ChatWidgetPresentation = Schema.Struct({
  title: Label,
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
  html: TrimmedNonEmptyString.check(Schema.isMaxLength(6000)),
  height: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 640 })),
}).check(
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 6_000 ||
      "Keep the complete widget input under 6 KB.",
  ),
);
export type ChatWidgetPresentation = typeof ChatWidgetPresentation.Type;

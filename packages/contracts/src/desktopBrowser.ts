import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserSignInResult } from "./browserPasswords.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /** Result of a saved-login request made by the server's browser engine. */
  Schema.Struct({
    type: Schema.Literal("passwordResult"),
    requestId: TrimmedNonEmptyString,
    result: Schema.optional(BrowserSignInResult),
    error: Schema.optional(Schema.String),
  }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  /** Ask the desktop's encrypted browser vault to fill a permitted login. */
  Schema.Struct({
    type: Schema.Literal("passwordSignIn"),
    ...TabKey,
    requestId: TrimmedNonEmptyString,
    username: Schema.optional(Schema.String),
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;

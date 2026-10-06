import * as Schema from "effect/Schema";

/** Metadata only. Password values never cross the desktop bridge. */
export const BrowserSavedLogin = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  origin: Schema.String,
  username: Schema.String,
  allowAgent: Schema.Boolean,
});
export type BrowserSavedLogin = typeof BrowserSavedLogin.Type;

export const BrowserPasswordList = Schema.Struct({
  origin: Schema.NullOr(Schema.String),
  logins: Schema.Array(BrowserSavedLogin),
});
export type BrowserPasswordList = typeof BrowserPasswordList.Type;

export const BrowserPasswordImportResult = Schema.Struct({
  imported: Schema.Int,
  skipped: Schema.Int,
  cancelled: Schema.Boolean,
});

export const BrowserSignInResult = Schema.Struct({
  status: Schema.Literals(["filled", "submitted", "needs-human"]),
});
export type BrowserSignInResult = typeof BrowserSignInResult.Type;

export interface DesktopBrowserPasswords {
  list: (tabId: string) => Promise<BrowserPasswordList>;
  importFile: (tabId: string) => Promise<typeof BrowserPasswordImportResult.Type>;
  remove: (tabId: string, id: string) => Promise<void>;
  setAgentAccess: (tabId: string, id: string, allowed: boolean) => Promise<void>;
  fill: (tabId: string, id: string) => Promise<BrowserSignInResult>;
  signIn: (tabId: string, username?: string, controlEpoch?: number) => Promise<BrowserSignInResult>;
}

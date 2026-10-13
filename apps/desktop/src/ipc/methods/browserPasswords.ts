import {
  BrowserPasswordList,
  BrowserPasswordImportResult,
  BrowserSignInResult,
  DesktopPreviewTabInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as BrowserPasswords from "../../preview/BrowserPasswords.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const loginInput = Schema.Struct({ ...DesktopPreviewTabInputSchema.fields, id: Schema.String });

const list = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PASSWORD_LIST_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: BrowserPasswordList,
  handler: Effect.fn("desktop.ipc.passwords.list")(function* ({ tabId }) {
    const passwords = yield* BrowserPasswords.BrowserPasswords;
    return yield* passwords.list(tabId);
  }),
});

const importFile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PASSWORD_IMPORT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: BrowserPasswordImportResult,
  handler: Effect.fn("desktop.ipc.passwords.importFile")(function* ({ tabId }) {
    const passwords = yield* BrowserPasswords.BrowserPasswords;
    return yield* passwords.importFile(tabId);
  }),
});

const remove = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PASSWORD_REMOVE_CHANNEL,
  payload: loginInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.passwords.remove")(function* ({ tabId, id }) {
    const passwords = yield* BrowserPasswords.BrowserPasswords;
    return yield* passwords.remove(tabId, id);
  }),
});

const setAgentAccess = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PASSWORD_SET_AGENT_ACCESS_CHANNEL,
  payload: Schema.Struct({ ...loginInput.fields, allowed: Schema.Boolean }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.passwords.setAgentAccess")(function* ({ tabId, id, allowed }) {
    const passwords = yield* BrowserPasswords.BrowserPasswords;
    return yield* passwords.setAgentAccess(tabId, id, allowed);
  }),
});

const fill = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PASSWORD_FILL_CHANNEL,
  payload: loginInput,
  result: BrowserSignInResult,
  handler: Effect.fn("desktop.ipc.passwords.fill")(function* ({ tabId, id }) {
    const passwords = yield* BrowserPasswords.BrowserPasswords;
    return yield* passwords.fill(tabId, id);
  }),
});

const signIn = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PASSWORD_SIGN_IN_CHANNEL,
  payload: Schema.Struct({
    ...DesktopPreviewTabInputSchema.fields,
    username: Schema.optional(Schema.String),
    controlEpoch: Schema.optional(Schema.Int),
  }),
  result: BrowserSignInResult,
  handler: Effect.fn("desktop.ipc.passwords.signIn")(function* ({ tabId, username, controlEpoch }) {
    const passwords = yield* BrowserPasswords.BrowserPasswords;
    return yield* passwords.signIn(tabId, username, controlEpoch);
  }),
});

export const methods = [list, importFile, remove, setAgentAccess, fill, signIn] as const;

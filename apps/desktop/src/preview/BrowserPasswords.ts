import * as NodeCrypto from "node:crypto";
import type {
  BrowserPasswordList,
  BrowserPasswordImportResult,
  BrowserSignInResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as PreviewManager from "./Manager.ts";
import { BrowserPasswordError, parsePasswordCsv, SavedPassword } from "./PasswordImport.ts";

const isBrowserPasswordError = Schema.is(BrowserPasswordError);
const VaultDocument = Schema.Struct({
  version: Schema.Literal(1),
  logins: Schema.Array(SavedPassword),
});
const encodeVault = Schema.encodeSync(Schema.fromJsonString(VaultDocument));
const decodeVault = Schema.decodeUnknownEffect(Schema.fromJsonString(VaultDocument));
type PasswordError = BrowserPasswordError | PreviewManager.PreviewManagerError;

export class BrowserPasswords extends Context.Service<
  BrowserPasswords,
  {
    readonly list: (tabId: string) => Effect.Effect<BrowserPasswordList, PasswordError>;
    readonly importFile: (
      tabId: string,
    ) => Effect.Effect<typeof BrowserPasswordImportResult.Type, PasswordError>;
    readonly remove: (tabId: string, id: string) => Effect.Effect<void, PasswordError>;
    readonly setAgentAccess: (
      tabId: string,
      id: string,
      allowed: boolean,
    ) => Effect.Effect<void, PasswordError>;
    readonly fill: (tabId: string, id: string) => Effect.Effect<BrowserSignInResult, PasswordError>;
    readonly signIn: (
      tabId: string,
      username?: string,
      controlEpoch?: number,
    ) => Effect.Effect<BrowserSignInResult, PasswordError>;
  }
>()("@t3tools/desktop/preview/BrowserPasswords") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const manager = yield* PreviewManager.PreviewManager;
  const lock = yield* Semaphore.make(1);
  const directory = environment.path.join(environment.stateDir, "browser-passwords");
  const file = environment.path.join(directory, "vault.bin");
  const protectErrors = <A, E, R>(effect: Effect.Effect<A, E, R>, reason: string) =>
    effect.pipe(Effect.mapError(() => new BrowserPasswordError({ reason })));

  const encryptionReady = Effect.gen(function* () {
    const available = yield* protectErrors(
      storage.isEncryptionAvailable,
      "System encryption is unavailable.",
    );
    const backend = yield* storage.selectedStorageBackend;
    if (!available || Option.getOrNull(backend) === "basic_text") {
      return yield* new BrowserPasswordError({
        reason:
          "Unlock your system keychain before using saved logins. Passwords are never saved without encryption.",
      });
    }
  });

  const load = Effect.gen(function* () {
    yield* encryptionReady;
    const bytes = yield* fs
      .readFile(file)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(
                new BrowserPasswordError({ reason: "Could not read the password vault." }),
              ),
        ),
      );
    if (bytes === null) return [] as ReadonlyArray<SavedPassword>;
    // Decode failures may include plaintext; discard the original errors at this boundary.
    const raw = yield* protectErrors(
      storage.decryptString(bytes),
      "Could not unlock the password vault with this system keychain.",
    );
    const document = yield* protectErrors(
      decodeVault(raw),
      "The password vault could not be read. It has not been changed.",
    );
    return document.logins;
  });

  const save = (logins: ReadonlyArray<SavedPassword>) =>
    protectErrors(
      Effect.gen(function* () {
        yield* encryptionReady;
        const encrypted = yield* storage.encryptString(encodeVault({ version: 1, logins }));
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const temporary = environment.path.join(directory, `${NodeCrypto.randomUUID()}.tmp`);
        yield* fs
          .writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" })
          .pipe(
            Effect.andThen(fs.rename(temporary, file)),
            Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
          );
      }),
      "Could not save the encrypted password vault. Your previous logins are unchanged.",
    );

  const list = (tabId: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const context = yield* manager.passwordContext(tabId);
        const logins = yield* load;
        return {
          origin: context.origin,
          logins: logins
            .filter((login) => login.partition === context.partition)
            .map(({ password: _password, partition: _partition, ...metadata }) => metadata),
        };
      }),
    );

  const importFile = Effect.fn("BrowserPasswords.importFile")(function* (tabId: string) {
    const context = yield* manager.passwordContext(tabId);
    const files = yield* protectErrors(
      dialog.pickFiles({
        owner: Option.none(),
        defaultPath: Option.none(),
        multiple: false,
        filters: [{ name: "Password export", extensions: ["csv"] }],
      }),
      "Could not open the password export picker.",
    );
    const selected = files[0];
    if (!selected) return { imported: 0, skipped: 0, cancelled: true };
    const stat = yield* protectErrors(fs.stat(selected), "Could not read the selected export.");
    if (stat.type !== "File" || Number(stat.size) > 5_000_000) {
      return yield* new BrowserPasswordError({
        reason: "Choose a CSV password export smaller than 5 MB.",
      });
    }
    const text = yield* protectErrors(
      fs.readFileString(selected),
      "Could not read the selected export.",
    );
    const parsed = yield* Effect.try({
      try: () => parsePasswordCsv(text),
      catch: (error) =>
        isBrowserPasswordError(error)
          ? error
          : new BrowserPasswordError({ reason: "Could not read this password export." }),
    });
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* manager.passwordContext(tabId);
        if (current.partition !== context.partition) {
          return yield* new BrowserPasswordError({
            reason: "The browser profile changed. Start the import again.",
          });
        }
        const logins = [...(yield* load)];
        for (const item of parsed.logins) {
          const index = logins.findIndex(
            (login) =>
              login.partition === context.partition &&
              login.origin === item.origin &&
              login.username === item.username,
          );
          const previous = logins[index];
          const login = {
            ...item,
            id: previous?.id ?? NodeCrypto.randomUUID(),
            partition: context.partition,
            allowAgent: false,
          };
          if (index < 0) logins.push(login);
          else logins[index] = login;
        }
        if (parsed.logins.length > 0) yield* save(logins);
        return { imported: parsed.logins.length, skipped: parsed.skipped, cancelled: false };
      }),
    );
  });

  const changeLogin = (tabId: string, id: string, allowed?: boolean) =>
    lock.withPermit(
      Effect.gen(function* () {
        const context = yield* manager.passwordContext(tabId);
        const logins = yield* load;
        const target = logins.find(
          (login) => login.id === id && login.partition === context.partition,
        );
        if (!target)
          return yield* new BrowserPasswordError({
            reason: "That saved login no longer exists in this profile.",
          });
        yield* save(
          allowed === undefined
            ? logins.filter((login) => login !== target)
            : logins.map((login) => (login === target ? { ...login, allowAgent: allowed } : login)),
        );
      }),
    );

  const useLogin = (
    tabId: string,
    agent: boolean,
    id?: string,
    username?: string,
    controlEpoch?: number,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const epoch = agent
          ? yield* manager.checkAutomationControl(tabId, "signIn", controlEpoch)
          : undefined;
        const context = yield* manager.passwordContext(tabId);
        if (!context.origin)
          return yield* new BrowserPasswordError({
            reason: "Open the matching HTTPS sign-in page first.",
          });
        const matches = (yield* load).filter(
          (login) =>
            login.partition === context.partition &&
            login.origin === context.origin &&
            (id === undefined || login.id === id) &&
            (!agent || login.allowAgent) &&
            (username === undefined || login.username === username),
        );
        if (matches.length !== 1)
          return yield* new BrowserPasswordError({
            reason:
              matches.length === 0
                ? "No permitted saved login matches this website and browser profile. Ask the user to import a login or allow agent sign-in in Saved logins."
                : "More than one permitted login matches. Specify the username or ask the user to choose in Saved logins.",
          });
        return yield* manager.fillPassword(tabId, matches[0]!, context.webContentsId, agent, epoch);
      }),
    );

  return BrowserPasswords.of({
    list,
    importFile,
    remove: (tabId, id) => changeLogin(tabId, id),
    setAgentAccess: (tabId, id, allowed) => changeLogin(tabId, id, allowed),
    fill: (tabId, id) => useLogin(tabId, false, id),
    signIn: (tabId, username, epoch) => useLogin(tabId, true, undefined, username, epoch),
  });
});

export const layer = Layer.effect(BrowserPasswords, make);

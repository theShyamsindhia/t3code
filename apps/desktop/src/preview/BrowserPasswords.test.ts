import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as Manager from "./Manager.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import type { SavedPassword } from "./PasswordImport.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-password-test-" });
  const exportPath = path.join(home, "export.csv");
  yield* fs.writeFileString(
    exportPath,
    "name,url,username,password\nExample,https://example.com/login,me,fixture-secret",
  );
  const state = {
    partition: "profile-a",
    origin: "https://example.com",
    available: true,
    backend: "keychain",
    cancelled: false,
  };
  const filled: SavedPassword[] = [];
  // OS encryption is replaced by a test-only key; disk persistence still uses real ciphertext.
  const key = NodeCrypto.randomBytes(32);
  const storage = ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.sync(() => state.available),
    selectedStorageBackend: Effect.sync(() => Option.some(state.backend)),
    encryptString: (text) =>
      Effect.sync(() => {
        const iv = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
        const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
      }),
    decryptString: (value) =>
      Effect.try({
        try: () => {
          const bytes = Buffer.from(value);
          const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
        },
        catch: (cause) => new ElectronSafeStorage.ElectronSafeStorageDecryptError({ cause }),
      }),
  });
  const service = yield* BrowserPasswords.BrowserPasswords.pipe(
    Effect.provide(
      BrowserPasswords.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              stateDir: home,
              path,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, storage),
            Layer.succeed(ElectronDialog.ElectronDialog, {
              pickFiles: () => Effect.sync(() => (state.cancelled ? [] : [exportPath])),
            } as unknown as ElectronDialog.ElectronDialog["Service"]),
            Layer.succeed(Manager.PreviewManager, {
              passwordContext: () =>
                Effect.sync(() => ({
                  partition: state.partition,
                  origin: state.origin,
                  webContentsId: 42,
                })),
              checkAutomationControl: () => Effect.succeed(0),
              fillPassword: (_tabId: string, login: SavedPassword, _id: number, submit: boolean) =>
                Effect.sync(() => {
                  filled.push(login);
                  return { status: submit ? "submitted" : "filled" } as const;
                }),
            } as unknown as Manager.PreviewManager["Service"]),
          ),
        ),
      ),
    ),
  );
  return {
    service,
    state,
    home,
    exportPath,
    filled,
    vault: path.join(home, "browser-passwords/vault.bin"),
  };
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("encrypted browser passwords", () => {
  it.effect("stores ciphertext and returns only metadata; import resets agent permission", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, vault, exportPath } = yield* fixture;
        assert.deepEqual(yield* service.importFile("tab"), {
          imported: 1,
          skipped: 0,
          cancelled: false,
        });
        const bytes = yield* fs.readFile(vault);
        assert.isFalse(Buffer.from(bytes).includes(Buffer.from("fixture-secret")));
        const { logins } = yield* service.list("tab");
        assert.deepEqual(Object.keys(logins[0]!).sort(), [
          "allowAgent",
          "id",
          "name",
          "origin",
          "username",
        ]);
        assert.isFalse(logins[0]!.allowAgent);
        yield* service.setAgentAccess("tab", logins[0]!.id, true);
        yield* fs.writeFileString(
          exportPath,
          "url,username,password\nhttps://example.com/other,me,changed-secret",
        );
        yield* service.importFile("tab");
        const updated = (yield* service.list("tab")).logins;
        assert.lengthOf(updated, 1);
        assert.equal(updated[0]!.id, logins[0]!.id);
        assert.isFalse(updated[0]!.allowAgent);
      }),
    ),
  );

  it.effect(
    "requires exact origin and per-login permission; revocation and removal take effect",
    () =>
      run(
        Effect.gen(function* () {
          const { service, state, filled } = yield* fixture;
          yield* service.importFile("tab");
          const id = (yield* service.list("tab")).logins[0]!.id;
          yield* service.signIn("tab").pipe(Effect.flip);
          assert.lengthOf(filled, 0);
          yield* service.setAgentAccess("tab", id, true);
          assert.deepEqual(yield* service.signIn("tab"), { status: "submitted" });
          state.origin = "https://example.com:8443";
          yield* service.fill("tab", id).pipe(Effect.flip);
          yield* service.signIn("tab").pipe(Effect.flip);
          assert.lengthOf(filled, 1);
          state.origin = "https://example.com";
          yield* service.setAgentAccess("tab", id, false);
          yield* service.signIn("tab").pipe(Effect.flip);
          yield* service.fill("tab", id);
          yield* service.remove("tab", id);
          assert.lengthOf((yield* service.list("tab")).logins, 0);
          yield* service.fill("tab", id).pipe(Effect.flip);
          assert.lengthOf(filled, 2);
        }),
      ),
  );

  it.effect(
    "isolates profiles and requires account selection when multiple accounts are permitted",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { service, state, exportPath, filled } = yield* fixture;
          yield* fs.writeFileString(
            exportPath,
            "url,username,password\nhttps://example.com,one,first\nhttps://example.com,two,second",
          );
          yield* service.importFile("tab");
          const logins = (yield* service.list("tab")).logins;
          for (const login of logins) yield* service.setAgentAccess("tab", login.id, true);
          yield* service.signIn("tab").pipe(Effect.flip);
          assert.lengthOf(filled, 0);
          yield* service.signIn("tab", "two");
          assert.equal(filled[0]!.username, "two");
          state.partition = "profile-b";
          assert.lengthOf((yield* service.list("tab")).logins, 0);
          yield* service.fill("tab", logins[0]!.id).pipe(Effect.flip);
          yield* service.setAgentAccess("tab", logins[0]!.id, true).pipe(Effect.flip);
          yield* service.remove("tab", logins[0]!.id).pipe(Effect.flip);
          yield* service.signIn("tab", "two").pipe(Effect.flip);
          assert.lengthOf(filled, 1);
        }),
      ),
  );

  it.effect("never writes with unavailable encryption or the Linux plaintext backend", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, state, vault } = yield* fixture;
        state.available = false;
        yield* service.importFile("tab").pipe(Effect.flip);
        assert.isFalse(yield* fs.exists(vault));
        state.available = true;
        state.backend = "basic_text";
        yield* service.importFile("tab").pipe(Effect.flip);
        assert.isFalse(yield* fs.exists(vault));
      }),
    ),
  );

  it.effect("does not overwrite an unreadable vault or expose a decryption cause", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, vault } = yield* fixture;
        yield* service.importFile("tab");
        yield* fs.writeFileString(vault, "broken-secret-fixture");
        const failure = yield* service.importFile("tab").pipe(Effect.flip);
        assert.notInclude(String(failure), "broken-secret-fixture");
        assert.equal(yield* fs.readFileString(vault), "broken-secret-fixture");
      }),
    ),
  );

  it.effect("cancelling the file picker leaves the vault absent", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, state, vault } = yield* fixture;
        state.cancelled = true;
        assert.deepEqual(yield* service.importFile("tab"), {
          imported: 0,
          skipped: 0,
          cancelled: true,
        });
        assert.isFalse(yield* fs.exists(vault));
      }),
    ),
  );
});

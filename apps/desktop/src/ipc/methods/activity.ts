import { DesktopActivitySnapshot } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import { DesktopActivityPanel } from "../../activity/DesktopActivityPanel.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { ACTIVITY_OPEN_THREAD_CHANNEL, SET_ACTIVITY_SNAPSHOT_CHANNEL } from "../channels.ts";

export const installDesktopActivity = Effect.fn("desktop.ipc.installDesktopActivity")(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform !== "darwin") return;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const app = yield* ElectronApp.ElectronApp;
  const windows = yield* ElectronWindow.ElectronWindow;
  const desktop = yield* DesktopWindow.DesktopWindow;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const activity = new DesktopActivityPanel((thread) => {
    runFork(
      Effect.gen(function* () {
        const window = yield* desktop.revealOrCreateMain;
        if (thread)
          window.webContents.send(ACTIVITY_OPEN_THREAD_CHANNEL, {
            environmentId: thread.environmentId,
            threadId: thread.threadId,
          });
      }).pipe(Effect.catch((error) => Effect.logWarning("Could not open activity chat", error))),
    );
  });
  let owner: Electron.BrowserWindow | null = null;
  const clear = () => activity.update(null);
  const navigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !isInPlace) clear();
  };
  const detach = () => {
    if (owner && !owner.isDestroyed()) {
      owner.removeListener("closed", clear);
      owner.webContents.removeListener("render-process-gone", clear);
      owner.webContents.removeListener("did-start-navigation", navigation);
    }
    owner = null;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      detach();
      activity.dispose();
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_ACTIVITY_SNAPSHOT_CHANNEL,
      payload: Schema.NullOr(DesktopActivitySnapshot),
      result: Schema.Void,
      handler: (snapshot, event) =>
        Effect.gen(function* () {
          const main = yield* windows.currentMainOrFirst;
          if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id) return;
          if (owner !== main.value) {
            detach();
            owner = main.value;
            owner.once("closed", clear);
            owner.webContents.on("render-process-gone", clear);
            owner.webContents.on("did-start-navigation", navigation);
          }
          activity.update(snapshot);
        }),
    }),
  );
  yield* app.on("before-quit", clear);
});

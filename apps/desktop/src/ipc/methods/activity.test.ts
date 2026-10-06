import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const panel = vi.hoisted(() => ({ update: vi.fn(), dispose: vi.fn(), created: vi.fn() }));
vi.mock("../../activity/DesktopActivityPanel.ts", () => ({
  DesktopActivityPanel: class {
    update = panel.update;
    dispose = panel.dispose;
    constructor() {
      panel.created();
    }
  },
}));
vi.mock("electron", () => ({}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installDesktopActivity } from "./activity.ts";

beforeEach(() => vi.clearAllMocks());

it.effect("does not create native activity UI on other platforms", () =>
  installDesktopActivity().pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(DesktopIpc.DesktopIpc, {} as DesktopIpc.DesktopIpc["Service"]),
    Effect.provideService(
      DesktopWindow.DesktopWindow,
      {} as DesktopWindow.DesktopWindow["Service"],
    ),
    Effect.provideService(ElectronApp.ElectronApp, {} as ElectronApp.ElectronApp["Service"]),
    Effect.provideService(
      ElectronWindow.ElectronWindow,
      {} as ElectronWindow.ElectronWindow["Service"],
    ),
    Effect.asVoid,
    // The branch exits before asking for any macOS-only dependencies.
    Effect.tap(() => Effect.sync(() => expect(panel.created).not.toHaveBeenCalled())),
  ),
);

it.effect("accepts only the main renderer, validates snapshots, and clears stale activity", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const windowListeners = new Map<string, (...args: unknown[]) => void>();
    const webListeners = new Map<string, (...args: unknown[]) => void>();
    const appListeners = new Map<string, () => void>();
    const main = {
      isDestroyed: () => false,
      once: (event: string, listener: (...args: unknown[]) => void) =>
        windowListeners.set(event, listener),
      removeListener: (event: string) => windowListeners.delete(event),
      webContents: {
        id: 1,
        on: (event: string, listener: (...args: unknown[]) => void) =>
          webListeners.set(event, listener),
        removeListener: (event: string) => webListeners.delete(event),
      },
    };
    const snapshot = { threads: [], attentionCount: 0, workingCount: 0, unavailableCount: 0 };
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installDesktopActivity();
        const handler = handlers.get("desktop:set-activity-snapshot")!;
        yield* Effect.promise(() => Promise.resolve(handler({ sender: { id: 2 } }, snapshot)));
        expect(panel.update).not.toHaveBeenCalled();
        yield* Effect.promise(() =>
          expect(
            handler({ sender: { id: 1 } }, { ...snapshot, workingCount: -1 }),
          ).rejects.toBeDefined(),
        );
        yield* Effect.promise(() => Promise.resolve(handler({ sender: { id: 1 } }, snapshot)));
        expect(panel.update).toHaveBeenLastCalledWith(snapshot);
        for (const event of ["render-process-gone", "did-start-navigation"]) {
          webListeners.get(event)!({}, "t3://app", false, true);
          expect(panel.update).toHaveBeenLastCalledWith(null);
          yield* Effect.promise(() => Promise.resolve(handler({ sender: { id: 1 } }, snapshot)));
        }
        windowListeners.get("closed")!();
        expect(panel.update).toHaveBeenLastCalledWith(null);
      }),
    ).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeedSome(main),
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(
        DesktopWindow.DesktopWindow,
        {} as DesktopWindow.DesktopWindow["Service"],
      ),
      Effect.provideService(ElectronApp.ElectronApp, {
        on: (event: string, listener: () => void) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(event, listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(event);
              }),
          ),
      } as ElectronApp.ElectronApp["Service"]),
      Effect.provide(
        DesktopIpc.layer({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ),
    );
    expect(panel.dispose).toHaveBeenCalledOnce();
    expect(handlers.size + windowListeners.size + webListeners.size + appListeners.size).toBe(0);
  }),
);

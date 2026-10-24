import * as NodeVM from "node:vm";
import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type {
  DesktopPreviewRecordingInputEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewPasskeys from "./Passkeys.ts";

describe("fitPictureInPictureContentSize", () => {
  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes macOS Paste and Match Style when Option changes the key to a symbol", () => {
    const pasteAndMatchStyle = input("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(PreviewManager.isPreviewEditingShortcut(pasteAndMatchStyle, "darwin")).toBe(true);
    for (const modifiers of [
      { code: "KeyC" },
      { alt: false },
      { shift: false },
      { control: true },
    ]) {
      expect(
        PreviewManager.isPreviewEditingShortcut({ ...pasteAndMatchStyle, ...modifiers }, "darwin"),
      ).toBe(false);
    }
  });
});

describe("previewWindowOpenAction", () => {
  const details = (overrides: {
    readonly url?: string;
    readonly disposition?: Electron.HandlerDetails["disposition"];
  }) => ({
    url: "https://accounts.google.com/o/oauth2/auth",
    disposition: "new-window" as Electron.HandlerDetails["disposition"],
    ...overrides,
  });

  it("opens a real window for scripted popups so the opener survives", () => {
    // OAuth SDKs read a null `window.open()` as a blocked popup, and they need
    // the opener alive to receive the credential back.
    expect(PreviewManager.previewWindowOpenAction(details({}))).toBe("popup");
    expect(
      PreviewManager.previewWindowOpenAction(details({ url: "http://localhost:5173/auth" })),
    ).toBe("popup");
  });

  it("keeps a form POST with a body on the in-place path", () => {
    // A new tab can only reopen the URL as a GET, which would drop the body.
    const postBody = { data: [], contentType: "application/x-www-form-urlencoded" };
    expect(
      PreviewManager.previewWindowOpenAction({
        ...details({ disposition: "foreground-tab" }),
        postBody,
      }),
    ).toBe("navigate");
  });

  it("does not hand a window to schemes that cannot be hardened", () => {
    // A popup skips the `will-attach-webview` hardening, so it only gets a window
    // when its preferences can be overridden. Chromium copies the guest's
    // preferences for `about:blank` and forbids overriding them.
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "vscode://vscode-remote/ssh-remote+box/tmp",
      "not a url",
    ]) {
      expect(PreviewManager.previewWindowOpenAction(details({ url }))).toBe("navigate");
    }
  });

  it("denies a blank window instead of blanking the opener", () => {
    // MSAL opens `about:blank` first and falls back to a redirect on `null`;
    // loading the blank page into the tab would destroy that fallback.
    for (const url of ["about:blank", ""]) {
      for (const disposition of ["new-window", "foreground-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("deny");
      }
    }
  });
});

const {
  browserWindowConstructor,
  clipboardItemConstructor,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  previewSession,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeClipboard,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  clipboardItemConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean; readonly toPNG: () => Buffer } => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from("png"),
  })),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  previewSession: { on: vi.fn() },
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeClipboard: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  ClipboardItem: class {
    constructor(data: Record<string, unknown>) {
      clipboardItemConstructor(data);
    }
  },
  clipboard: {
    write: writeClipboard,
  },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const layerBrowserSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.succeed(previewSession as unknown as Electron.Session),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const layerEnvironment = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
    dirname: "/tmp/t3/desktop",
    path: {
      join: (...parts: ReadonlyArray<string>) => parts.join("/"),
    },
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const layerFileSystem = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
});

const managerLayer = (platform: NodeJS.Platform = "darwin") =>
  PreviewManager.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
        register: () => Effect.void,
        recordMetrics: () => Effect.void,
        shutdown: Effect.void,
      }),
    ),
    Layer.provideMerge(DesktopBrowserHost.layer),
    Layer.provideMerge(layerBrowserSession),
    Layer.provideMerge(
      Layer.mock(PreviewPasskeys.PreviewPasskeys)({
        bridgeEnabled: false,
        installSessionHandlers: () => {},
        attachGuest: () => () => {},
      }),
    ),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(layerFileSystem),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, platform)),
  );

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
  platform: NodeJS.Platform = "darwin",
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(managerLayer(platform)), Effect.scoped);

const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError);

interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  /** Only fixtures that deliver picture-in-picture frames need pixels to fingerprint. */
  readonly toBitmap?: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

interface TestHostWebContents {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  readonly isDestroyed: () => boolean;
  readonly session: {
    readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly displayMediaHandler: () => TestDisplayMediaHandler | undefined;
}

type TestPreviewWebContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

const makeTestHostWebContents = (): TestHostWebContents => {
  let handler: TestDisplayMediaHandler | undefined;
  return {
    id: 7,
    mainFrame: { frameTreeNodeId: 7 },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: TestDisplayMediaHandler) => {
        handler = next;
      }),
    },
    displayMediaHandler: () => handler,
  };
};

const makeTestPreviewWebContents = (
  capturePage: () => Promise<TestCapturedPreviewImage>,
  id = 42,
  hostWebContents: TestHostWebContents = makeTestHostWebContents(),
) => {
  const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
  return {
    id,
    mainFrame: { routingId: id },
    hostWebContents,
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoadingMainFrame: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    setBackgroundThrottling,
    isCurrentlyAudible: () => false,
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage,
  } as unknown as TestPreviewWebContents;
};

const setupRecordingRaceTabs = (manager: PreviewManager.PreviewManager["Service"]) =>
  Effect.gen(function* () {
    const capturePage = vi.fn(async () => ({
      toJPEG: () => Buffer.from("unused-recording-frame"),
      getSize: () => ({ width: 1280, height: 720 }),
    }));
    const host = makeTestHostWebContents();
    const destroyedIds = new Set<number>();
    const makeWebContents = (id: number) =>
      Object.assign(makeTestPreviewWebContents(capturePage, id, host), {
        executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        isDestroyed: () => destroyedIds.has(id),
      });
    const webContentsById = new Map([
      [41, makeWebContents(41)],
      [42, makeWebContents(42)],
    ]);
    fromId.mockImplementation((id) =>
      id === undefined ? null : (webContentsById.get(id) ?? null),
    );
    yield* manager.createTab("tab_race_a");
    yield* manager.createTab("tab_race_b");
    yield* manager.registerWebview("tab_race_a", 41);
    yield* manager.registerWebview("tab_race_b", 42);
    const grants: Array<{ video?: unknown }> = [];
    return {
      host,
      grants,
      destroy: (id: number) => destroyedIds.add(id),
      takeGrant: (frame = host.mainFrame) =>
        host.displayMediaHandler()?.({ frame }, (value) => {
          grants.push(value);
        }),
    };
  });

const TEST_FAVICON = "data:image/png;base64,cG5n";

const makeSourcePng = (width = 1, height = 1): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const makeFaviconWebContents = (options?: {
  readonly changes?: ChangeSignal;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly id?: number;
  readonly rasterize?: (code: string) => Promise<unknown>;
  readonly url?: string;
}) => {
  const sourcePng = makeSourcePng();
  const listeners = new Map<string, (...args: never[]) => void>();
  let currentUrl = options?.url ?? "http://localhost:3200/";
  let destroyed = false;
  let loading = false;
  const fetchImpl =
    options?.fetch ??
    (async () =>
      new Response(new Uint8Array(sourcePng), {
        headers: { "content-type": "image/png" },
      }));
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const response = fetchImpl(url, init);
    options?.changes?.notify();
    return response;
  });
  const executeJavaScriptInIsolatedWorld = vi.fn(
    (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) => {
      const result = options?.rasterize
        ? options.rasterize(scripts[0]?.code ?? "")
        : Promise.resolve(TEST_FAVICON);
      options?.changes?.notify();
      return result;
    },
  );
  const reload = vi.fn();
  const loadURL = vi.fn(async (url: string) => {
    currentUrl = url;
  });
  const off = vi.fn();
  const debuggerOff = vi.fn();
  const webContents = {
    id: options?.id ?? 42,
    isDestroyed: () => destroyed,
    getType: () => "webview",
    getURL: () => currentUrl,
    getTitle: () => "Preview",
    isLoadingMainFrame: () => loading,
    isDevToolsOpened: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    isCurrentlyAudible: () => false,
    reload,
    reloadIgnoringCache: vi.fn(),
    loadURL,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
    }),
    off,
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    session: { fetch, storagePath: "/tmp/test-profile" },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    isFocused: vi.fn(() => true),
    focusedFrame: {} as object | null,
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    executeJavaScriptInIsolatedWorld,
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: debuggerOff,
    },
  };
  return {
    executeJavaScriptInIsolatedWorld,
    fetch,
    debuggerOff,
    listeners,
    loadURL,
    off,
    reload,
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
    setLoading: (value: boolean) => {
      loading = value;
    },
    setUrl: (url: string) => {
      currentUrl = url;
    },
    webContents: webContents as never,
  };
};

// Electron mocks and state subscribers call `notify`, so a wait re-checks its
// predicate exactly when the state it reads changes.
const makeChangeSignal = () => {
  const waiters = new Set<() => void>();
  return {
    notify: () => {
      for (const wake of waiters) wake();
    },
    until: (predicate: () => boolean) =>
      Effect.callback<void>((resume) => {
        if (predicate()) return resume(Effect.void);
        const wake = () => {
          if (!predicate()) return;
          waiters.delete(wake);
          resume(Effect.void);
        };
        waiters.add(wake);
        return Effect.sync(() => void waiters.delete(wake));
      }),
  };
};
type ChangeSignal = ReturnType<typeof makeChangeSignal>;

// Favicon captures run detached from the Electron listener, so asserting that
// one published nothing can only give its promise chain a fixed number of turns.
const flushMicrotasks = function* () {
  for (let turn = 0; turn < 30; turn++) yield* Effect.promise(() => Promise.resolve());
};

const makeTestPictureInPictureWindow = (loadURL: () => Promise<void> = async () => undefined) => {
  const listeners = new Map<string, () => void>();
  const webContentsListeners = new Map<string, () => void>();
  const send = vi.fn();
  let destroyed = false;
  const webContents = {
    on: vi.fn((event: string, listener: () => void) => {
      webContentsListeners.set(event, listener);
    }),
    off: vi.fn((event: string) => {
      webContentsListeners.delete(event);
    }),
    send,
  };
  const pictureInPictureWindow = {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAspectRatio: vi.fn(),
    getContentSize: vi.fn(() => [480, 320]),
    setContentSize: vi.fn(),
    loadURL: vi.fn(loadURL),
    showInactive: vi.fn(() => {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
    }),
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      listeners.get("closed")?.();
    }),
    get webContents() {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
      return webContents;
    },
  };
  return { pictureInPictureWindow, send, webContentsListeners };
};

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    previewSession.on.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    clipboardItemConstructor.mockClear();
    writeClipboard.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  effectIt.effect.each([
    ["linux", "ctrl+alt+[", "[", "BracketLeft", false],
    ["win32", "ctrl+alt+8", "[", "Digit8", false],
    ["win32", "ctrl+alt+k", "K", "KeyK", false],
    ["linux", "ctrl+alt+`", "Dead", "Backquote", false],
    ["darwin", "ctrl+alt+[", "[", "BracketLeft", true],
    ["linux", "ctrl+alt+f7", "F7", "F7", true],
  ] as const)(
    "handles ambiguous preview chords on %s: %s",
    ([platform, chord, key, code, expected]) =>
      withManager(
        (manager) =>
          Effect.gen(function* () {
            const preview = makeFaviconWebContents();
            const send = vi.fn();
            Object.assign(preview.webContents, {
              hostWebContents: { isDestroyed: () => false, send },
            });
            fromId.mockReturnValue(preview.webContents);
            yield* manager.createTab("tab_alt_graph");
            yield* manager.registerWebview("tab_alt_graph", 42);
            yield* manager.setForwardedShortcuts([
              { command: "view.reopenClosed", shortcut: parseKeybindingShortcut(chord)! },
            ]);
            const preventDefault = vi.fn();
            preview.listeners.get("before-input-event")!(
              { preventDefault } as never,
              {
                type: "keyDown",
                key,
                code,
                meta: false,
                control: true,
                shift: false,
                alt: true,
              } as never,
            );
            expect(preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
            expect(send).toHaveBeenCalledTimes(expected ? 1 : 0);
          }),
        platform,
      ),
  );

  effectIt.effect("preserves focused browser editing in tabs and sign-in popups", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        yield* manager.createTab("tab_editing");
        yield* manager.registerWebview("tab_editing", 42);

        const popup = makeFaviconWebContents({ id: 43 });
        preview.listeners.get("did-create-window")!({ webContents: popup.webContents } as never);
        expect(
          (popup.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenCalledWith(true);

        for (const browser of [preview, popup]) {
          const contents = browser.webContents as Electron.WebContents;
          const beforeInput = browser.listeners.get("before-input-event")!;
          const preventDefault = vi.fn();
          const input = {
            type: "keyDown",
            key: "v",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          };
          beforeInput({ preventDefault } as never, input as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
          beforeInput(
            { preventDefault } as never,
            { ...input, type: "keyUp", key: "Meta", meta: false } as never,
          );
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);

          beforeInput({ preventDefault } as never, { ...input, key: "w" } as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);

          vi.mocked(contents.isFocused).mockReturnValue(false);
          beforeInput({ preventDefault } as never, input as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
          expect(preventDefault).not.toHaveBeenCalled();
        }
      }),
    ),
  );

  effectIt.effect("reports an unregistered webview as temporarily unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(yield* manager.automationStatus("tab_1")).toEqual({
          automationControl: "ready",
          controlEpoch: 0,
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });

        yield* manager.createTab("tab_1");

        expect(yield* manager.automationStatus("tab_1")).toEqual({
          automationControl: "ready",
          controlEpoch: 0,
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });
        expect(fromId).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("keeps editing and forwarded shortcuts in whichever tab holds focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const send = vi.fn();
        const host = { isDestroyed: () => false, send };
        const older = makeFaviconWebContents({ id: 42 });
        const newer = makeFaviconWebContents({ id: 43 });
        for (const tab of [older, newer]) Object.assign(tab.webContents, { hostWebContents: host });
        // Electron names one arbitrary guest here when several share a focused window.
        getFocusedWebContents.mockReturnValue(newer.webContents as never);
        fromId.mockReturnValue(older.webContents);
        yield* manager.createTab("tab_older");
        yield* manager.registerWebview("tab_older", 42);
        fromId.mockReturnValue(newer.webContents);
        yield* manager.createTab("tab_newer");
        yield* manager.registerWebview("tab_newer", 43);
        const shortcut = parseKeybindingShortcut("mod+shift+t")!;
        yield* manager.setForwardedShortcuts([{ command: "view.reopenClosed", shortcut }]);

        const beforeInput = older.listeners.get("before-input-event")!;
        const key = { type: "keyDown", meta: true, control: false, alt: false };
        beforeInput(
          { preventDefault: vi.fn() } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (older.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(false);

        const preventDefault = vi.fn();
        beforeInput({ preventDefault } as never, { ...key, key: "T", shift: true } as never);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledExactlyOnceWith("desktop:menu-action", "view.reopenClosed");

        // The person types in the older tab, so keys reaching the newer one are an agent's.
        Object.assign(newer.webContents, { focusedFrame: null });
        const agentInput = newer.listeners.get("before-input-event")!;
        const agentPreventDefault = vi.fn();
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (newer.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(true);
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "T", shift: true } as never,
        );
        expect(agentPreventDefault).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("isolates failed state listeners and continues delivery", () => {
    const loggedErrors: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (typeof value === "object" && value !== null && "cause" in value) {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>));
        }
      }
    });
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: "send-window-message",
      platform: "darwin",
      windowId: 42,
      channel: "preview:state-change",
      cause: new Error("renderer unavailable"),
    });
    const delivered = vi.fn();

    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError));
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            delivered(tabId, state);
          }),
        );

        const state = yield* manager.createTab("tab_listener_failure");

        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledWith("tab_listener_failure", state);
        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError);
        expect(loggedErrors[0]).toMatchObject({
          operation: "send-window-message",
          windowId: 42,
          channel: "preview:state-change",
        });
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

  effectIt.effect("does not swallow state listener interruption", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.subscribeStateChanges(() => Effect.interrupt);
            return yield* Effect.exit(manager.createTab("tab_interrupted_listener"));
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    ),
  );

  effectIt.effect("queues navigation until the webview registers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "about:blank",
          getTitle: () => "",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

        expect(yield* manager.automationStatus("tab_pending")).toEqual({
          automationControl: "paused",
          controlEpoch: 1,
          available: false,
          visible: true,
          tabId: "tab_pending",
          url: "http://localhost:3200/",
          title: "",
          loading: true,
        });

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("detaches through the pinned debugger after the webview is destroyed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        // Real Electron throws on any `wc.debugger` access once the
        // WebContents is destroyed, so cleanup must go through the debugger
        // reference captured at attach time (electron/electron#53376).
        let destroyed = false;
        let attached = false;
        const debuggerOff = vi.fn();
        const debuggerDetach = vi.fn(() => {
          attached = false;
        });
        const wcDebugger = {
          isAttached: () => attached,
          attach: vi.fn(() => {
            attached = true;
          }),
          detach: debuggerDetach,
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: debuggerOff,
        };
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => destroyed,
          getType: () => "webview",
          getURL: () => "http://localhost:3200/",
          getTitle: () => "Preview",
          isLoadingMainFrame: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          reload: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          get debugger() {
            if (destroyed) throw new Error("Object has been destroyed");
            return wcDebugger;
          },
        } as never);
        yield* manager.createTab("tab_pinned_debugger");
        yield* manager.registerWebview("tab_pinned_debugger", 42);
        yield* manager.setColorScheme("tab_pinned_debugger", "dark");
        expect(attached).toBe(true);
        destroyed = true;

        yield* manager.navigate("tab_pinned_debugger", "https://example.com/");

        expect(debuggerOff).toHaveBeenCalledWith("message", expect.any(Function));
        expect(debuggerDetach).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("does not let destroyed-webview cleanup detach a same-id replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const previous = makeFaviconWebContents();
        const replacement = makeFaviconWebContents({ url: "https://example.com/" });
        let current = previous.webContents;
        let startReplacementRegistration: () => void = () => void 0;
        const replacementReady = new Promise<void>((resolve) => {
          startReplacementRegistration = resolve;
        });
        fromId.mockImplementation(() => current);
        yield* manager.createTab("tab_destroyed_replacement_race");
        yield* manager.registerWebview("tab_destroyed_replacement_race", 42);
        yield* manager.setColorScheme("tab_destroyed_replacement_race", "dark");
        const replacementRegistration = yield* Effect.promise(() => replacementReady).pipe(
          Effect.flatMap(() => manager.registerWebview("tab_destroyed_replacement_race", 42)),
          Effect.forkChild({ startImmediately: true }),
        );
        previous.setDestroyed(true);
        previous.debuggerOff.mockImplementationOnce(() => {
          current = replacement.webContents;
          startReplacementRegistration();
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.navigate("tab_destroyed_replacement_race", "https://example.com/");
        const registrationExit = yield* Fiber.await(replacementRegistration);

        expect(Exit.isSuccess(registrationExit)).toBe(true);
        expect(previous.off).toHaveBeenCalled();
        expect(replacement.off).not.toHaveBeenCalled();
        expect(states.at(-1)).toMatchObject({
          webContentsId: 42,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    ),
  );

  effectIt.effect("shares an identical in-flight event and lets a changed event win", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
        const preview = makeFaviconWebContents({
          changes,
          fetch: (url) =>
            url.endsWith("first.png")
              ? firstResponse
              : Promise.resolve(
                  new Response(new Uint8Array(makeSourcePng()), {
                    headers: { "content-type": "image/png" },
                  }),
                ),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_latest");
        yield* manager.registerWebview("tab_favicon_latest", 42);

        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        faviconUpdated({} as never, ["http://localhost:3200/second.png"] as never);
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);
        resolveFirst(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(preview.fetch).toHaveBeenCalledTimes(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("does not publish a capture invalidated by navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const preview = makeFaviconWebContents({
          changes,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_navigation");
        yield* manager.registerWebview("tab_favicon_navigation", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        preview.listeners.get("did-start-navigation")?.({
          isMainFrame: true,
          isSameDocument: false,
        } as never);
        preview.setUrl("https://example.com/");
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    ),
  );

  effectIt.effect("ignores an old capture that completes after webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const initial = makeFaviconWebContents({
          changes,
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        const replacement = makeFaviconWebContents({ changes, id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_late_replace");
        yield* manager.registerWebview("tab_favicon_late_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("tab_favicon_late_replace", 43);
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(
          states.some((state) => state.webContentsId === 43 && state.favicon !== undefined),
        ).toBe(false);
      }),
    ),
  );

  effectIt.effect("treats a reused WebContents id as a new attachment", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        const initial = makeFaviconWebContents({ changes, id: 42 });
        const replacement = makeFaviconWebContents({ changes, id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(initial.off).toHaveBeenCalled();
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    ),
  );

  const makeAttachingGuest = (id: number) => {
    const listeners = new Map<string, () => void>();
    const attach = vi.fn();
    const detach = vi.fn();
    const sendCommand = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => undefined,
    );
    const detachListeners = new Set<() => void>();
    let chromiumDetaches = 0;
    let destroyed = false;
    const wc = {
      id,
      isDestroyed: () => destroyed,
      isDevToolsOpened: () => {
        // Electron throws from native methods once a WebContents is destroyed.
        if (destroyed) throw new TypeError("Object has been destroyed");
        return false;
      },
      getType: () => "webview",
      getURL: () => "http://localhost:5173/README.md",
      getTitle: () => "README.md",
      isLoadingMainFrame: () => true,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      on: vi.fn(),
      off: vi.fn(),
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => attach.mock.calls.length > detach.mock.calls.length + chromiumDetaches,
        attach,
        detach,
        sendCommand,
        on: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.add(listener);
        },
        off: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.delete(listener);
        },
      },
    };
    /** Chromium dropping the debugger without a detach() call. */
    const chromiumDetach = () => {
      chromiumDetaches += 1;
      // Snapshot like an EventEmitter, so a listener added during emit waits for the next one.
      for (const listener of Array.from(detachListeners)) listener();
    };
    return {
      wc: wc as unknown as Electron.WebContents,
      attach,
      detach,
      sendCommand,
      chromiumDetach,
      destroy: () => {
        destroyed = true;
        listeners.get("destroyed")?.();
      },
    };
  };

  effectIt.effect("reattaches a debugger that Chromium dropped on its own", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAttachingGuest(48);
        fromId.mockReturnValue(guest.wc);
        yield* manager.createTab("tab_detached");
        yield* manager.registerWebview("tab_detached", 48);
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(1);

        guest.chromiumDetach();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("skips a guest destroyed while another guest's session opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const slow = makeAttachingGuest(46);
        let releaseSlow = () => {};
        const slowCommand = new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        slow.sendCommand.mockImplementation(() => slowCommand);
        const queued = makeAttachingGuest(47);

        const slowFiber = yield* manager
          .prepareWebview(slow.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const queuedFiber = yield* manager
          .prepareWebview(queued.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        queued.destroy();
        releaseSlow();

        expect(Exit.isSuccess(yield* Fiber.await(slowFiber))).toBe(true);
        expect(Exit.isSuccess(yield* Fiber.await(queuedFiber))).toBe(true);
        expect(slow.attach).toHaveBeenCalledTimes(1);
        expect(queued.attach).not.toHaveBeenCalled();
      }),
    ),
  );

  const makeAudioWebContents = (id: number) => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const setAudioMuted = vi.fn();
    let audible = false;
    let audibleAfterFirstRead = false;
    let audibleReads = 0;
    return {
      setAudioMuted,
      emitAudioState: (next: boolean) => {
        audible = next;
        listeners.get("audio-state-changed")?.({ audible: next } as never);
      },
      /**
       * Starts playing between the attach-time read and the post-attach
       * reconcile, without a delivered event — the window in which
       * audio-state-changed fires against a guest the tab does not own yet.
       */
      startPlayingAfterFirstRead: () => {
        audibleAfterFirstRead = true;
      },
      wc: {
        id,
        isDestroyed: () => false,
        isDevToolsOpened: () => false,
        getType: () => "webview",
        getURL: () => "https://example.com",
        getTitle: () => "Example",
        isLoadingMainFrame: () => false,
        getZoomFactor: () => 1,
        setZoomFactor: vi.fn(),
        setAudioMuted,
        isCurrentlyAudible: () => {
          audibleReads += 1;
          if (audibleAfterFirstRead && audibleReads > 1) return true;
          return audible;
        },
        loadURL: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (...args: never[]) => void) => {
          listeners.set(event, listener);
        }),
        off: vi.fn((event: string) => {
          listeners.delete(event);
        }),
        ipc: { on: vi.fn(), off: vi.fn() },
        send: webviewSend,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setIgnoreMenuShortcuts: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        debugger: {
          isAttached: () => false,
          attach: vi.fn(),
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
        },
      } as never,
    };
  };

  effectIt.effect("reconciles audibility that changed while the guest attached", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        guest.startPlayingAfterFirstRead();
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_window");
        yield* manager.registerWebview("tab_audio_window", 42);
        yield* Effect.yieldNow;

        // audio-state-changed for this transition was dropped: it fired before
        // the tab owned the guest. Without a post-attach reconcile the icon
        // stays wrong until the next real transition, which may never come.
        expect(states.at(-1)?.audible).toBe(true);
      }),
    ),
  );

  effectIt.effect("ignores audio state from a replaced guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_stale");
        yield* manager.registerWebview("tab_audio_stale", 42);
        yield* Effect.yieldNow;

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio_stale", 43);
        yield* Effect.yieldNow;

        const publishedBefore = states.length;
        first.emitAudioState(true);
        yield* Effect.yieldNow;

        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.audible).toBe(false);
      }),
    ),
  );

  effectIt.effect("blocks late webview and capture starts during tab close", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("close-race-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(capturePage, 43);
        const replacementListenerSpies = replacementWebContents as unknown as {
          readonly on: ReturnType<typeof vi.fn>;
          readonly off: ReturnType<typeof vi.fn>;
          readonly ipc: { readonly off: ReturnType<typeof vi.fn> };
        };
        fromId.mockImplementation((id) => {
          if (id === 42) return firstWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_close_register_race");
        yield* manager.registerWebview("tab_close_register_race", 42);
        yield* manager.openPictureInPicture("tab_close_register_race");

        const closeCleanupPaused = yield* Deferred.make<void>();
        const continueCloseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(closeCleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(continueCloseCleanup)),
              )
            : Effect.void,
        );

        const closeFiber = yield* manager
          .closeTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeCleanupPaused);
        const recreateFiber = yield* manager
          .createTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const registrationFiber = yield* manager
          .registerWebview("tab_close_register_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        yield* manager.closeTab("tab_close_register_race");
        const recordingExit = yield* Effect.exit(manager.startRecording("tab_close_register_race"));
        yield* Deferred.succeed(continueCloseCleanup, undefined);
        yield* Fiber.join(closeFiber);
        const recreated = yield* Fiber.join(recreateFiber);
        const registrationExit = yield* Fiber.await(registrationFiber);

        for (const exit of [registrationExit, recordingExit] as ReadonlyArray<
          Exit.Exit<unknown, PreviewManager.PreviewManagerError>
        >) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) continue;
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab_close_register_race",
          });
        }
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        expect(replacementListenerSpies.off).not.toHaveBeenCalled();
        expect(replacementListenerSpies.ipc.off).not.toHaveBeenCalled();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recreated.webContentsId).toBeNull();
      }),
    ),
  );

  effectIt.effect("preserves both screenshots of the same site in the same millisecond", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstPng = Buffer.from("first-preview-png");
        const secondPng = Buffer.from("second-preview-png");
        const pngImage = (png: Buffer) => ({
          toPNG: () => png,
          toJPEG: () => png,
          getSize: () => ({ width: 1280, height: 720 }),
        });
        const capturePage = vi
          .fn<() => Promise<ReturnType<typeof pngImage>>>()
          .mockResolvedValueOnce(pngImage(firstPng))
          .mockResolvedValueOnce(pngImage(secondPng));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        // it.effect keeps TestClock fixed until explicitly advanced.
        const first = yield* manager.captureScreenshot("tab_1");
        const second = yield* manager.captureScreenshot("tab_1");

        expect(first.createdAt).toBe(second.createdAt);
        expect(first.id).not.toBe(second.id);
        expect(first.path).not.toBe(second.path);
        expect(first.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(second.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(writeFile.mock.calls).toEqual([
          [first.path, firstPng],
          [second.path, secondPng],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps every recorded guest unthrottled until its frame capture stops", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const firstWebContents = makeTestPreviewWebContents(capturePage, 41, host);
        const secondWebContents = makeTestPreviewWebContents(capturePage, 42, host);
        const webContentsById = new Map([
          [41, firstWebContents],
          [42, secondWebContents],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_capture_throttling_1");
        yield* manager.createTab("tab_capture_throttling_2");
        yield* manager.registerWebview("tab_capture_throttling_1", 41);
        yield* manager.registerWebview("tab_capture_throttling_2", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        yield* manager.startRecording("tab_capture_throttling_1");
        host.displayMediaHandler()?.({ frame: host.mainFrame }, () => {});
        yield* manager.startRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_1");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("does not commit failed starts and retries throttle restoration", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_capture_throttling_failure");
        yield* manager.registerWebview("tab_capture_throttling_failure", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("start throttling update failed");
        });
        const failedStart = yield* Effect.exit(
          manager.startRecording("tab_capture_throttling_failure"),
        );
        expect(Exit.isFailure(failedStart)).toBe(true);

        yield* manager.startRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false]]);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("stop throttling update failed");
        });
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false], [true], [true]]);

        yield* manager.startRecording("tab_capture_throttling_failure");
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [false],
          [true],
          [true],
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps frame capture closed when a replacement is destroyed during cleanup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windowEvents = new Map<string, () => void>();
        const host = makeTestHostWebContents();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const guest = makeTestPreviewWebContents(capturePage, 42, host);
        fromId.mockReturnValue(guest);
        yield* manager.createTab("tab_shutdown");
        yield* manager.registerWebview("tab_shutdown", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: (event: string, listener: () => void) => windowEvents.set(event, listener),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);
        yield* manager.startRecording("tab_shutdown");
        const pip = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pip.pictureInPictureWindow;
        });
        yield* manager.openPictureInPicture("tab_shutdown");
        const capturesBeforeClose = capturePage.mock.calls.length;
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          state.pictureInPicture
            ? Effect.void
            : Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
              ),
        );

        windowEvents.get("closed")!();
        yield* Deferred.await(cleanupStarted);
        let destroyed = false;
        const replacement = yield* manager
          .setMainWindow({
            isDestroyed: () => destroyed,
            once: vi.fn(),
            webContents: { setBackgroundThrottling: vi.fn() },
          } as never)
          .pipe(Effect.forkChild({ startImmediately: true }));
        try {
          expect(replacement.pollUnsafe()).toBeUndefined();
          destroyed = true;
        } finally {
          yield* Deferred.succeed(releaseCleanup, undefined);
        }
        yield* Fiber.join(replacement);

        const restart = yield* Effect.exit(manager.startRecording("tab_shutdown"));
        expect(Exit.isFailure(restart)).toBe(true);
        if (Exit.isFailure(restart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(restart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_shutdown",
          });
        }
        expect(capturePage).toHaveBeenCalledTimes(capturesBeforeClose);
        expect(pip.pictureInPictureWindow.isDestroyed()).toBe(true);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);
      }),
    ),
  );

  effectIt.effect("ignores close events from replaced main windows", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeFirstWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_replaced_window_close");
        yield* manager.registerWebview("tab_replaced_window_close", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeFirstWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);

        closeFirstWindow?.();
        yield* manager.startRecording("tab_replaced_window_close");
        expect(firstWindowThrottling).not.toHaveBeenCalled();
        expect(replacementWindowThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_replaced_window_close");
        expect(replacementWindowThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("releases frame capture when the main window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const webContentsById = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42, host)],
          [43, makeTestPreviewWebContents(capturePage, 43, host)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_window_close_recording");
        yield* manager.createTab("tab_window_close_race");
        yield* manager.registerWebview("tab_window_close_recording", 42);
        yield* manager.registerWebview("tab_window_close_race", 43);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.startRecording("tab_window_close_recording");
        expect(firstWindowThrottling.mock.calls).toEqual([[false]]);

        closeMainWindow?.();
        const racedStart = yield* Effect.exit(manager.startRecording("tab_window_close_race"));
        expect(Exit.isFailure(racedStart)).toBe(true);
        if (Exit.isFailure(racedStart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(racedStart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_race",
          });
        }
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);
        expect(replacementWindowThrottling).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("does not arm recording after the main window closes during warmup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        const capturedImage = {
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(
          () =>
            new Promise<TestCapturedPreviewImage>((resolve) => {
              markWarmupStarted();
              finishWarmup = resolve;
            }),
        );
        const host = makeTestHostWebContents();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, host));

        yield* manager.createTab("tab_window_close_warmup");
        yield* manager.registerWebview("tab_window_close_warmup", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);

        const start = yield* manager
          .startRecording("tab_window_close_warmup")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        closeMainWindow?.();
        finishWarmup(capturedImage);

        const exit = yield* Fiber.await(start);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_warmup",
          });
        }
        expect(host.session.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("tells the server when a tab it renders natively closes", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
      const lines = yield* Queue.unbounded<string>();
      yield* host.events.pipe(
        Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
        Effect.forkScoped,
      );
      const nextType = Queue.take(lines).pipe(
        Effect.map((line) => /"type":"(\w+)"/.exec(line)?.[1]),
      );
      const capturePage = vi.fn(async () => ({
        toPNG: () => Buffer.from("png"),
        toJPEG: () => Buffer.from("jpeg"),
        getSize: () => ({ width: 100, height: 80 }),
      }));
      fromId.mockReturnValue(
        Object.assign(makeTestPreviewWebContents(capturePage, 42), {
          isDevToolsOpened: () => false,
          getUserAgent: () => "Electron",
        }),
      );
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.createTab("tab_1", { serverTab });
      yield* manager.registerWebview("tab_1", 42);
      expect(yield* nextType).toBe("attached");
      yield* manager.closeTab("tab_1");
      expect(yield* nextType).toBe("detached");
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("discards a screenshot that resolves after its guest is replaced", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toPNG: () => Buffer.from("stale-png"),
          toJPEG: () => Buffer.from("stale-jpeg"),
          getSize: () => ({ width: 100, height: 80 }),
        };
        const pending = Promise.withResolvers<typeof image>();
        const capturePage = vi.fn(() => pending.promise);
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const fiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(0);
        expect(capturePage).toHaveBeenCalledOnce();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 43));
        yield* manager.registerWebview("tab_1", 43);
        pending.resolve(image);
        const exit = yield* Fiber.join(fiber);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();
        expect(writeFile).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("grants each concurrent preview recording its own tab frame", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstJpeg = Buffer.from("first-recording-frame");
        const secondJpeg = Buffer.from("second-recording-frame");
        const firstCapturePage = vi.fn(async () => ({
          toJPEG: () => firstJpeg,
          getSize: () => ({ width: 800, height: 600 }),
        }));
        const secondCapturePage = vi.fn(async () => ({
          toJPEG: () => secondJpeg,
          getSize: () => ({ width: 390, height: 844 }),
        }));
        const firstSendCommand = vi.fn(async () => undefined);
        const secondSendCommand = vi.fn(async () => undefined);
        const host = makeTestHostWebContents();
        const makeWebContents = (
          id: number,
          capturePage: typeof firstCapturePage,
          sendCommand: typeof firstSendCommand,
        ) =>
          ({
            id,
            mainFrame: { routingId: id },
            hostWebContents: host,
            executeJavaScript: vi.fn(async () =>
              id === 41 ? { width: 800, height: 600 } : { width: 390, height: 844 },
            ),
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            isLoadingMainFrame: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setAudioMuted: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            isCurrentlyAudible: () => false,
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setIgnoreMenuShortcuts: vi.fn(),
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
            capturePage,
          }) as never;
        const webContentsById = new Map([
          [41, makeWebContents(41, firstCapturePage, firstSendCommand)],
          [42, makeWebContents(42, secondCapturePage, secondSendCommand)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );
        yield* manager.createTab("tab_1");
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_1", 41);
        yield* manager.registerWebview("tab_2", 42);

        const grants: Array<{ video?: unknown }> = [];
        const takeGrant = () =>
          host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => {
            grants.push(value);
          });

        yield* manager.startRecording("tab_1");
        takeGrant();
        yield* manager.startRecording("tab_2");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 41 } }, { video: { routingId: 42 } }]);

        expect(firstCapturePage).toHaveBeenCalledOnce();
        expect(secondCapturePage).toHaveBeenCalledOnce();
        expect(firstSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );
        expect(secondSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );

        yield* Effect.all([manager.stopRecording("tab_1"), manager.stopRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });
      }),
    ),
  );

  effectIt.effect("only lets the host frame that armed a recording claim its stream", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        takeGrant({ frameTreeNodeId: 999 });
        takeGrant();

        expect(grants).toEqual([{}, { video: { routingId: 41 } }]);
        yield* manager.stopRecording("tab_race_a");
      }),
    ),
  );

  effectIt.effect("reclaims the arm slot from a destroyed webContents", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant, destroy } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        destroy(41);
        yield* manager.startRecording("tab_race_b");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 42 } }]);

        yield* manager.stopRecording("tab_race_b");
      }),
    ),
  );

  effectIt.effect("gates recording decorations and isolates failed subscribers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const callbacks = new Map<
          string,
          (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined
        >();
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => ({
            toJPEG: () => Buffer.from("frame"),
            getSize: () => ({ width: 800, height: 600 }),
          })),
          {
            ipc: {
              on: (
                channel: string,
                callback: (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined,
              ) => callbacks.set(channel, callback),
              off: vi.fn(),
            },
          },
        );
        fromId.mockReturnValue(contents as never);
        yield* manager.createTab("tab_recording_input");
        yield* manager.registerWebview("tab_recording_input", 42);
        const received: DesktopPreviewRecordingInputEvent[] = [];
        yield* manager.subscribeRecordingInputs(() => Effect.die("renderer unavailable"));
        yield* manager.subscribeRecordingInputs((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        );
        const send = (input: unknown) =>
          Effect.gen(function* () {
            const fiber = callbacks.get("preview:recording-input")?.(null, input);
            if (fiber) yield* Fiber.join(fiber);
          });
        const key = { type: "key", label: "⌘C", held: true, width: 800 };
        const pointer = {
          type: "pointer",
          phase: "down",
          x: 120,
          y: 80,
          width: 800,
          height: 600,
        };
        yield* send(key);
        expect(received).toEqual([]);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: true,
          showMousePresses: false,
        });
        yield* send(key);
        yield* send(pointer);
        yield* send({ ...key, width: 0 });
        expect(received).toEqual([{ tabId: "tab_recording_input", input: key }]);
        yield* manager.stopRecording("tab_recording_input");
        yield* send(key);
        expect(received).toHaveLength(1);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: false,
          showMousePresses: true,
        });
        yield* send(key);
        yield* send(pointer);
        expect(received.at(-1)).toEqual({ tabId: "tab_recording_input", input: pointer });
        expect(received).toHaveLength(2);
      }),
    ),
  );

  effectIt.effect("continues native recording when the source warmup fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => {
          throw new Error("source is not ready");
        });
        const host = makeTestHostWebContents();
        const webContents = Object.assign(makeTestPreviewWebContents(capturePage, 42, host), {
          executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        });
        fromId.mockReturnValue(webContents);

        yield* manager.createTab("tab_recording_warmup_failure");
        yield* manager.registerWebview("tab_recording_warmup_failure", 42);

        yield* manager.startRecording("tab_recording_warmup_failure");
        expect(capturePage).toHaveBeenCalledTimes(2);

        const handler = host.displayMediaHandler();
        const streams: Array<{ video?: unknown }> = [];
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        expect(streams).toEqual([{ video: { routingId: 42 } }, {}]);

        yield* manager.stopRecording("tab_recording_warmup_failure");
      }),
    ),
  );

  effectIt.effect("serializes recording source acquisition with webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturedImage = {
          toJPEG: () => Buffer.from("unused-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        const capturePage = vi
          .fn<() => Promise<TestCapturedPreviewImage>>()
          .mockImplementationOnce(
            () =>
              new Promise<TestCapturedPreviewImage>((resolve) => {
                markWarmupStarted();
                finishWarmup = resolve;
              }),
          )
          .mockResolvedValue(capturedImage);
        const initialWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementOn = vi.fn();
        const replacementWebContents = Object.assign(makeTestPreviewWebContents(capturePage, 43), {
          on: replacementOn,
        });
        fromId.mockImplementation((id) => {
          if (id === 42) return initialWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });

        yield* manager.createTab("tab_recording_replacement_race");
        yield* manager.registerWebview("tab_recording_replacement_race", 42);
        const start = yield* manager
          .startRecording("tab_recording_replacement_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        const replacement = yield* manager
          .registerWebview("tab_recording_replacement_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementOn).not.toHaveBeenCalled();

        finishWarmup(capturedImage);
        yield* Fiber.join(start);
        yield* Fiber.join(replacement);
        expect(replacementOn).toHaveBeenCalled();
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_recording_replacement_race");
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("does not publish picture-in-picture readiness after window teardown", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("closing-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        pictureInPictureWindow.showInactive.mockImplementationOnce(() => {
          pictureInPictureWindow.close();
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_pip_teardown");
        yield* manager.registerWebview("tab_pip_teardown", 42);
        const openExit = yield* Effect.exit(manager.openPictureInPicture("tab_pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(states.at(-1)?.pictureInPicture).toBe(false);
      }),
    ),
  );

  effectIt.effect("closes an initializing picture-in-picture without blocking later opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("serialized-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow: initializingWindow } = makeTestPictureInPictureWindow(
          () => new Promise<void>(() => {}),
        );
        const { pictureInPictureWindow: reopenedWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_concurrent_pip");
        yield* manager.registerWebview("tab_concurrent_pip", 42);

        const firstOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const secondOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const close = yield* manager
          .closePictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(initializingWindow.loadURL).toHaveBeenCalledOnce();
        expect(initializingWindow.close).toHaveBeenCalledOnce();
        const [firstOpenExit, secondOpenExit] = yield* Effect.all([
          Fiber.await(firstOpen),
          Fiber.await(secondOpen),
        ]);
        yield* Fiber.join(close);

        expect(Exit.hasInterrupts(firstOpenExit)).toBe(true);
        expect(Exit.hasInterrupts(secondOpenExit)).toBe(true);
        expect(initializingWindow.showInactive).not.toHaveBeenCalled();
        expect(capturePage).not.toHaveBeenCalled();
        expect(states.at(-1)?.pictureInPicture).toBe(false);

        yield* manager.openPictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(true);

        yield* manager.closePictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("rejects picture-in-picture when its webview changes during initialization", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("stale-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(initialCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        let resolveLoad: (() => void) | undefined;
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        );
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_replaced_webview");
        yield* manager.registerWebview("tab_replaced_webview", 42);
        const open = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(pictureInPictureWindow.loadURL).toHaveBeenCalledOnce();
        expect(resolveLoad).toBeDefined();
        const concurrentOpen = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab_replaced_webview", 43);
        resolveLoad?.();

        const openExits = yield* Effect.all([Fiber.await(open), Fiber.await(concurrentOpen)]);
        for (const openExit of openExits) {
          expect(Exit.isFailure(openExit)).toBe(true);
          if (Exit.isSuccess(openExit)) continue;
          const error = Option.getOrThrow(Cause.findErrorOption(openExit.cause));
          expect(error).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: "tab_replaced_webview",
            webContentsId: 42,
          });
        }
        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.showInactive).not.toHaveBeenCalled();
        expect(initialCapturePage).not.toHaveBeenCalled();
        expect(replacementCapturePage).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("starts live edit and keeps it active during subframe navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, (...args) => {
              listeners.delete(event);
              listener(...args);
            });
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1", "live-edit").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(webviewSend).toHaveBeenCalledWith(
          "preview:start-pick",
          expect.any(Object),
          "live-edit",
        );

        listeners.get("did-start-navigation")?.({
          url: "about:blank",
          isSameDocument: false,
          isMainFrame: false,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({
          url: "https://example.com/next",
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("keeps annotation send grants isolated and updates an active pick", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const picked = new Map<number, (event: unknown, ...args: unknown[]) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("annotation"),
          toDataURL: () => "data:image/png;base64,YW5ub3RhdGlvbg==",
          getSize: () => ({ width: 10, height: 10 }),
        }));
        const guests = new Map(
          [42, 43, 44].map(
            (id) =>
              [
                id,
                Object.assign(makeTestPreviewWebContents(capturePage, id), {
                  isFocused: () => true,
                  once: vi.fn(),
                  ipc: {
                    on: vi.fn(
                      (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
                        if (channel === "preview:element-picked") picked.set(id, listener);
                      },
                    ),
                    off: vi.fn(),
                    removeListener: vi.fn(),
                  },
                }),
              ] as const,
          ),
        );
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        yield* manager.createTab("tab_a");
        yield* manager.createTab("tab_b");
        yield* manager.registerWebview("tab_a", 42);
        yield* manager.registerWebview("tab_b", 43);
        yield* manager.setAnnotationSendEnabled("tab_a", true);
        const annotation = {
          id: "annotation-scopes",
          pageUrl: "https://example.com",
          pageTitle: "Example",
          comment: "Tighten this spacing",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-09-05T00:00:00.000Z",
        };
        for (const [tabId, id, nextGrant, expected] of [
          ["tab_b", 43, undefined, "attach"],
          ["tab_a", 42, false, "attach"],
          ["tab_a", 42, true, "send"],
        ] as const) {
          const pick = yield* manager.pickElement(tabId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          if (nextGrant !== undefined) {
            yield* manager.setAnnotationSendEnabled(tabId, nextGrant);
          }
          picked.get(id)?.({}, annotation, null, "send");
          const result = yield* Fiber.join(pick);
          expect(result?.annotation.id).toBe(annotation.id);
          expect(result?.submission).toBe(expected);
        }
        yield* manager.registerWebview("tab_a", 44);
        const replacementPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(replacementPick))?.submission).toBe("send");
        yield* manager.closeTab("tab_a");
        yield* manager.createTab("tab_a");
        yield* manager.registerWebview("tab_a", 44);
        const reopenedPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(reopenedPick))?.submission).toBe("attach");
      }),
    ),
  );

  describe("annotation screenshots", () => {
    const captureAnnotation = (
      cropRect: PreviewAnnotationRect | null,
      targets: Partial<Pick<PreviewAnnotationPayload, "elements" | "regions" | "strokes">> = {},
      emptyImage?: "viewport" | "crop",
    ) =>
      withManager((manager) =>
        Effect.gen(function* () {
          let onPicked: ((event: unknown, ...args: unknown[]) => void) | undefined;
          const crop = vi.fn((rect: Electron.Rectangle) => ({
            isEmpty: () => emptyImage === "crop",
            getSize: () =>
              emptyImage === "crop"
                ? { width: 0, height: 0 }
                : { width: rect.width, height: rect.height },
            toDataURL: () => (emptyImage === "crop" ? "data:," : "data:image/png;base64,cropped"),
          }));
          const capturePage = vi.fn(async () => ({
            isEmpty: () => emptyImage === "viewport",
            getSize: () =>
              emptyImage === "viewport" ? { width: 0, height: 0 } : { width: 2000, height: 1200 },
            toJPEG: () => Buffer.from("unused"),
            toDataURL: () => (emptyImage === "viewport" ? "data:," : "data:image/png;base64,full"),
            crop,
          }));
          fromId.mockReturnValue(
            Object.assign(makeTestPreviewWebContents(capturePage), {
              isFocused: () => true,
              once: vi.fn(),
              ipc: {
                on: vi.fn((channel: string, listener: typeof onPicked) => {
                  if (channel === "preview:element-picked") onPicked = listener;
                }),
                off: vi.fn(),
                removeListener: vi.fn(),
              },
            }),
          );

          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          onPicked?.(
            {},
            {
              id: "annotation_1",
              pageUrl: "https://example.com",
              pageTitle: "Example",
              comment: "Tighten this spacing",
              elements: [],
              regions: [],
              strokes: [],
              ...targets,
              styleChanges: [],
              screenshot: null,
              createdAt: "2026-06-11T00:00:00.000Z",
            },
            cropRect,
            "attach",
            2,
          );

          const result = yield* Fiber.join(pick);
          expect(capturePage).toHaveBeenCalledExactlyOnceWith();
          expect(result?.annotation.comment).toBe("Tighten this spacing");
          expect(result?.submission).toBe("attach");
          return { result, crop };
        }),
      );

    effectIt.effect("clips a partially visible selection to the captured viewport", () =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(
          { x: -40, y: 570, width: 240, height: 110 },
          { regions: [{ id: "region_1", rect: { x: -20, y: 590, width: 200, height: 70 } }] },
        );
        expect(crop).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 1140, width: 400, height: 60 });
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: 400,
          height: 60,
        });
      }),
    );

    effectIt.effect.each([
      {
        name: "an offscreen crop without individual target bounds",
        cropRect: { x: 1010, y: 40, width: 100, height: 70 },
        regions: [],
      },
      {
        name: "padding overlapping the viewport while its target is offscreen",
        cropRect: { x: 40, y: -100, width: 240, height: 110 },
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
      {
        name: "a union spanning the viewport with both targets offscreen",
        cropRect: { x: -230, y: 40, width: 1460, height: 110 },
        regions: [
          { id: "region_1", rect: { x: -210, y: 60, width: 200, height: 70 } },
          { id: "region_2", rect: { x: 1010, y: 60, width: 200, height: 70 } },
        ],
      },
      {
        name: "an offscreen target when crop bounds are missing",
        cropRect: null,
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
    ])("does not attach $name", ({ cropRect, regions }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, { regions });
        expect(crop).not.toHaveBeenCalled();
        expect(result?.annotation.screenshot).toBeNull();
        expect(result?.screenshotFailed).toBe(true);
      }),
    );

    // regression: #18441 zero-area strokes on the viewport edge must still get a screenshot crop
    effectIt.effect.each([
      {
        name: "zero-width SVG line on the left edge",
        rect: { x: 0, y: 60, width: 0, height: 70 },
        cropRect: { x: -20, y: 40, width: 40, height: 110 },
        expectedCrop: { x: 0, y: 80, width: 40, height: 220 },
      },
      {
        name: "zero-height SVG line on the top edge",
        rect: { x: 60, y: 0, width: 70, height: 0 },
        cropRect: { x: 40, y: -20, width: 110, height: 40 },
        expectedCrop: { x: 80, y: 0, width: 220, height: 40 },
      },
    ])("captures a stroked $name", ({ rect, cropRect, expectedCrop }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, {
          elements: [
            {
              id: "element_1",
              rect,
              element: {
                pageUrl: "https://example.com",
                pageTitle: "Example",
                tagName: "line",
                selector: "svg > line",
                htmlPreview: '<line stroke="black" stroke-width="2" />',
                componentName: null,
                source: null,
                stack: [],
                styles: "stroke: black; stroke-width: 2px;",
                pickedAt: "2026-06-11T00:00:00.000Z",
              },
            },
          ],
        });
        expect(crop).toHaveBeenCalledExactlyOnceWith(expectedCrop);
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: expectedCrop.width,
          height: expectedCrop.height,
        });
      }),
    );
  });

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("copies screenshot artifacts to the system clipboard", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

        yield* manager.copyArtifactToClipboard(artifactPath);

        expect(createFromPath).toHaveBeenCalledWith(artifactPath);
        expect(clipboardItemConstructor).toHaveBeenCalledWith({
          "image/png": expect.any(Blob),
        });
        expect(writeClipboard).toHaveBeenCalledOnce();
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);

        createFromPath.mockReturnValueOnce({
          isEmpty: () => true,
          toPNG: () => Buffer.from("invalid"),
        });
        const invalidImageExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(invalidImageExit)).toBe(true);
        if (Exit.isSuccess(invalidImageExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(invalidImageExit.cause))).toMatchObject({
          _tag: "PreviewArtifactImageLoadError",
          artifactPath,
        });

        const writeCause = new Error("clipboard write failed");
        writeClipboard.mockRejectedValueOnce(writeCause);
        const writeExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(writeExit)).toBe(true);
        if (Exit.isSuccess(writeExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(writeExit.cause))).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "copyArtifactToClipboard.write",
          artifactPath,
          cause: writeCause,
        });
      }),
    ),
  );

  effectIt.effect(
    "records the resolved pointer target before dispatching an automation click",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
          const activity: string[] = [];
          const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
            if (method === "Runtime.evaluate") {
              return {
                result: {
                  value: { width: 800, height: 600 },
                },
              };
            }
            if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
              activity.push("mousePressed");
              humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
            }
            return undefined;
          });
          fromId.mockReturnValue({
            id: 42,
            hostWebContents: makeTestHostWebContents(),
            capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("frame") })),
            setBackgroundThrottling: vi.fn(),
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://example.com",
            getTitle: () => "Example",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setAudioMuted: vi.fn(),
            isCurrentlyAudible: () => false,
            on: vi.fn(),
            off: vi.fn(),
            ipc: {
              on: vi.fn((channel: string, listener: typeof humanInput) => {
                if (channel === "preview:human-input") humanInput = listener;
              }),
              off: vi.fn(),
            },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setIgnoreMenuShortcuts: vi.fn(),
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
          } as never);

          yield* manager.subscribePointerEvents((event) =>
            Effect.sync(() => {
              activity.push(event.phase);
            }),
          );
          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          yield* manager.startRecording("tab_1");
          const click = yield* manager
            .automationClick("tab_1", { x: 120, y: 80 })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(200);
          yield* Fiber.join(click);

          expect(activity).toEqual(["move", "click", "mousePressed"]);
          expect(
            webviewSend.mock.calls
              .filter(([channel]) => channel === "preview:recording-controller")
              .map(([, controller]) => controller),
          ).toEqual(["agent", "none"]);

          const recordedPointer = webviewSend.mock.calls
            .filter(([channel]) => channel === "preview:recording-pointer")
            .map(([, event]) => event);
          expect(recordedPointer).toEqual([
            expect.objectContaining({ phase: "move", x: 120, y: 80 }),
            expect.objectContaining({ phase: "click", x: 120, y: 80 }),
          ]);
          expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: 120,
            y: 80,
            button: "left",
            clickCount: 1,
          });
          yield* manager.stopRecording("tab_1");
          expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: 120,
            y: 80,
            button: "left",
            clickCount: 1,
          });
        }),
      ),
  );

  effectIt.effect("types in background webviews and enables native key input", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failKeyDown = false;
        let routeToIframe = false;
        let interruptFrameKeyDown = false;
        let holdKeyUp = false;
        let releaseKeyUp: (() => void) | undefined;
        let notifyKeyUpQueued: (() => void) | undefined;
        const keyUpQueued = new Promise<void>((resolve) => {
          notifyKeyUpQueued = resolve;
        });
        const listeners = new Map<string, (event: unknown) => void>();
        const eventCounts = new Map<string, number>();
        const animationFrames = new Map<number, () => void>();
        let animationFrameId = 0;
        const renderFrame = () => {
          const callbacks = [...animationFrames.values()];
          animationFrames.clear();
          callbacks.forEach((callback) => callback());
        };
        const frameContext = NodeVM.createContext({
          performance: { eventCounts },
          requestAnimationFrame: (callback: () => void) => {
            const id = ++animationFrameId;
            animationFrames.set(id, callback);
            return id;
          },
          cancelAnimationFrame: (id: number) => animationFrames.delete(id),
          window: {
            addEventListener: (type: string, listener: (event: unknown) => void) =>
              listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
          },
        });
        const frame = {
          executeJavaScript: vi.fn(async (expression: string) =>
            NodeVM.runInContext(expression, frameContext),
          ),
        };
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(
          async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
            if (method === "Runtime.evaluate") {
              if (params?.["returnByValue"] === true) return { result: { value: { ok: true } } };
              return {
                result:
                  routeToIframe && !sessionId
                    ? { objectId: "focused-iframe-object" }
                    : { subtype: "null" },
              };
            }
            if (method === "DOM.describeNode") return { node: { frameId: "focused-frame" } };
            if (method === "Target.getTargets")
              return {
                targetInfos: [
                  { targetId: "unrelated-frame", type: "iframe" },
                  { targetId: "focused-frame", type: "iframe" },
                ],
              };
            if (method === "Target.attachToTarget") return { sessionId: "child-session" };
            if (method === "Input.dispatchKeyEvent" && params?.["type"] !== "keyUp") {
              if (failKeyDown) throw new Error("key dispatch failed");
              if (interruptFrameKeyDown)
                humanInput?.({}, { kind: "pointer", x: 80, y: 40, button: 0 });
            }
            return undefined;
          },
        );
        const sendInputEvent = vi.fn((input: Electron.KeyboardInputEvent) => {
          const signal = {
            kind: "key",
            key: input.keyCode,
            code: input.keyCode === "!" ? "Digit1" : `Key${input.keyCode.toUpperCase()}`,
          };
          if (input.type === "keyUp") {
            const deliver = () => {
              eventCounts.set("keyup", (eventCounts.get("keyup") ?? 0) + 1);
              renderFrame();
            };
            if (holdKeyUp) {
              releaseKeyUp = deliver;
              notifyKeyUpQueued?.();
            } else {
              queueMicrotask(deliver);
            }
          }
          if (input.type !== "keyDown") return;
          if (failKeyDown) throw new Error("key dispatch failed");
          humanInput?.({}, signal);
        });
        const restoreFocus = vi.fn();
        const focus = vi.fn();
        getFocusedWebContents.mockReturnValue({
          id: 7,
          isDestroyed: () => false,
          focus: restoreFocus,
        } as never);
        fromId.mockReturnValue({
          id: 42,
          mainFrame: { framesInSubtree: [frame] },
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          focus,
          sendInputEvent,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationType("tab_input", { text: "hello", clear: true });
        yield* manager.automationType("tab_input", { text: "", clear: true });
        yield* manager.automationPress("tab_input", { key: "x" });

        const calls = sendCommand.mock.calls;
        const methods = calls.map(([method]) => method);
        const enableIndex = methods.indexOf("Input.setIgnoreInputEvents");
        const focusOnIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === true,
        );
        const focusOffIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === false,
        );
        const typeEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('document.execCommand("insertText"'),
        );
        expect(typeEvaluation).toBeDefined();
        const clearOnlyEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('const text = ""') &&
            params.expression.includes("Object.getOwnPropertyDescriptor"),
        );
        expect(clearOnlyEvaluation).toBeDefined();
        expect(methods).not.toContain("Input.insertText");
        expect(enableIndex).toBeGreaterThanOrEqual(0);
        expect(methods).not.toContain("Page.bringToFront");
        expect(methods).not.toContain("Input.dispatchKeyEvent");
        expect(enableIndex).toBeLessThan(focusOnIndex);
        expect(sendCommand.mock.invocationCallOrder[focusOnIndex]).toBeLessThan(
          sendInputEvent.mock.invocationCallOrder[0]!,
        );
        expect(sendInputEvent.mock.invocationCallOrder[2]).toBeLessThan(
          sendCommand.mock.invocationCallOrder[focusOffIndex]!,
        );
        expect(sendInputEvent.mock.calls.map(([input]) => input.type)).toEqual([
          "keyDown",
          "char",
          "keyUp",
        ]);
        expect(sendCommand).toHaveBeenCalledWith("Input.setIgnoreInputEvents", { ignore: false });
        expect(listeners.size).toBe(0);
        expect(animationFrames.size).toBe(0);

        sendCommand.mockClear();
        sendInputEvent.mockClear();
        getFocusedWebContents.mockReturnValue(null);
        holdKeyUp = true;
        const backgroundPress = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => keyUpQueued);
        expect(sendCommand).not.toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        renderFrame();
        expect(animationFrames.size).toBe(1);
        releaseKeyUp?.();
        yield* Fiber.join(backgroundPress);
        expect(listeners.size).toBe(0);
        expect(animationFrames.size).toBe(0);
        expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        holdKeyUp = false;

        // Both native failures and expected-input matching must leave focus emulation off.
        for (const key of ["y", "!"]) {
          sendCommand.mockClear();
          sendInputEvent.mockClear();
          failKeyDown = key === "y";
          const exit = yield* Effect.exit(manager.automationPress("tab_input", { key }));
          expect(Exit.isFailure(exit)).toBe(failKeyDown);
          expect(sendInputEvent.mock.calls.map(([input]) => input.type)).toEqual(
            failKeyDown ? ["keyDown", "keyUp"] : ["keyDown", "char", "keyUp"],
          );
          expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: false,
          });
        }

        routeToIframe = true;
        sendInputEvent.mockClear();
        for (const outcome of ["success", "failure", "interrupted"]) {
          sendCommand.mockClear();
          failKeyDown = outcome === "failure";
          interruptFrameKeyDown = outcome === "interrupted";
          const exit = yield* Effect.exit(
            manager.automationPress("tab_input", {
              key: outcome === "success" ? "Enter" : "x",
            }),
          );
          expect(Exit.isSuccess(exit)).toBe(outcome === "success");
          if (outcome === "interrupted" && Exit.isFailure(exit)) {
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
              _tag: "PreviewAutomationControlInterruptedError",
            });
          }
          expect(sendInputEvent).not.toHaveBeenCalled();
          expect(sendCommand).toHaveBeenCalledWith("Target.attachToTarget", {
            targetId: "focused-frame",
            flatten: true,
          });
          expect(
            sendCommand.mock.calls
              .filter(([method]) => method === "Input.dispatchKeyEvent")
              .map(([, params, sessionId]) => ({ type: params?.["type"], sessionId })),
          ).toEqual([
            { type: "keyDown", sessionId: "child-session" },
            { type: "keyUp", sessionId: "child-session" },
          ]);
          expect(sendCommand).toHaveBeenCalledWith(
            "Emulation.setFocusEmulationEnabled",
            { enabled: false },
            "child-session",
          );
          expect(sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", {
            sessionId: "child-session",
          });
        }
        expect(focus).not.toHaveBeenCalled();
        expect(restoreFocus).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          hostWebContents: makeTestHostWebContents(),
          capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("frame") })),
          setBackgroundThrottling: vi.fn(),
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        yield* manager.startRecording("tab_1");

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          webviewSend.mock.calls
            .filter(([channel]) => channel === "preview:recording-controller")
            .map(([, controller]) => controller),
        ).toEqual(["agent", "human"]);
        yield* manager.stopRecording("tab_1");
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          operation: "click",
          tabId: "tab_1",
          webContentsId: 42,
        });
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.name).toBe("PreviewAutomationControlInterruptedError");
        }
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect(
    "releases evaluation objects after success, exceptions, takeover, and cancellation",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const retained = new Map<string, number>();
          const pendingEvaluation = yield* Deferred.make<void>();
          const lateRelease = yield* Deferred.make<void>();
          let finishEvaluation: (() => void) | undefined;
          let cancelledGroup: string | undefined;
          let humanInput: ((event: unknown, signal: unknown) => void) | undefined;
          const wc = makeTestPreviewWebContents(vi.fn());
          Object.assign(wc, { isDevToolsOpened: () => false });
          Object.assign(wc.ipc, {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
          });
          Object.assign(wc.debugger, {
            sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
              const group = String(params?.objectGroup ?? "");
              if (method === "Runtime.releaseObjectGroup") {
                retained.delete(group);
                if (group === cancelledGroup) Deferred.doneUnsafe(lateRelease, Effect.void);
              }
              if (method !== "Runtime.evaluate") return undefined;
              if (params?.expression === "cancelled") {
                cancelledGroup = group;
                Deferred.doneUnsafe(pendingEvaluation, Effect.void);
                await new Promise<void>((resolve) => {
                  finishEvaluation = resolve;
                });
              }
              retained.set(group, 2);
              if (params?.expression === "exception") {
                return {
                  result: { objectId: "exception-result" },
                  exceptionDetails: {
                    text: "failure",
                    exception: { objectId: "exception-detail" },
                  },
                };
              }
              if (params?.expression === "takeover") {
                humanInput?.({}, { kind: "pointer", x: 1, y: 2, button: 0 });
              }
              return { result: { value: 42 } };
            }),
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);

          expect(yield* manager.automationEvaluate("tab_1", { expression: "success" })).toBe(42);
          expect(retained.size).toBe(0);
          const failure = yield* Effect.exit(
            manager.automationEvaluate("tab_1", { expression: "exception" }),
          );
          expect(Exit.isFailure(failure)).toBe(true);
          expect(retained.size).toBe(0);
          const cancelled = yield* manager
            .automationEvaluate("tab_1", { expression: "cancelled" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(pendingEvaluation);
          yield* Fiber.interrupt(cancelled);
          finishEvaluation?.();
          yield* Deferred.await(lateRelease);
          expect(retained.size).toBe(0);
          const takeover = yield* Effect.exit(
            manager.automationEvaluate("tab_1", { expression: "takeover" }),
          );
          expect(Exit.isFailure(takeover)).toBe(true);
          if (Exit.isFailure(takeover)) {
            expect(Option.getOrThrow(Cause.findErrorOption(takeover.cause))).toMatchObject({
              _tag: "PreviewAutomationControlInterruptedError",
            });
          }
          expect(retained.size).toBe(0);
        }),
      ),
  );

  effectIt.effect("derives evaluation detail kind and length from the same non-empty source", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const text = "ReferenceError: fallbackDetail is not defined";
        const exceptionDetails = {
          text,
          exception: { description: "" },
        };
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { exceptionDetails } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const exit = yield* Effect.exit(
          manager.automationEvaluate("tab_1", { expression: "fallbackDetail" }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationEvaluationError",
          detailKind: "exception-text",
          detailLength: text.length,
          cause: exceptionDetails,
        });
      }),
    ),
  );
  effectIt.effect("keeps takeover latched per tab and requires a fresh snapshot after resume", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toPNG: () => Buffer.from("png"),
          toJPEG: () => Buffer.from("jpeg"),
          getSize: () => ({ width: 100, height: 80 }),
        };
        const signals = new Map<number, (event: unknown, signal: unknown) => void>();
        const takenOver = yield* Deferred.make<void>();
        const tabs = new Map(
          [42, 43].map((id) => {
            const wc = makeTestPreviewWebContents(async () => image, id);
            Object.assign(wc, {
              isDevToolsOpened: () => false,
              loadURL: vi.fn(async () => undefined),
            });
            Object.assign(wc.ipc, {
              on: vi.fn((channel: string, listener: (event: unknown, signal: unknown) => void) => {
                if (channel === "preview:human-input") signals.set(id, listener);
              }),
            });
            Object.assign(wc.debugger, {
              sendCommand: vi.fn(async (method: string, params?: { expression?: string }) => {
                if (method === "Runtime.evaluate")
                  return {
                    result: {
                      value:
                        params?.expression === "42"
                          ? 42
                          : {
                              url: "https://example.com/changed",
                              title: "Changed",
                              loading: false,
                              visibleText: "Current page",
                              interactiveElements: [],
                            },
                    },
                  };
                return {};
              }),
            });
            return [id, wc] as const;
          }),
        );
        fromId.mockImplementation((id) => (id === undefined ? null : (tabs.get(id) ?? null)));
        yield* manager.subscribeStateChanges((id, state) =>
          id === "tab_1" && state.automationControl === "paused"
            ? Deferred.succeed(takenOver, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_2", 43);
        yield* manager.automationEvaluate("tab_1", { expression: "42" });
        const originalEpoch = (yield* manager.automationStatus("tab_1")).controlEpoch;
        signals.get(42)?.({}, { kind: "pointer", x: 10, y: 10, button: 0 });
        yield* Deferred.await(takenOver);
        yield* TestClock.adjust(1000);
        expect((yield* manager.automationStatus("tab_1")).automationControl).toBe("paused");
        for (const operation of [
          "click",
          "type",
          "press",
          "scroll",
          "evaluate",
          "navigate",
          "open",
          "resize",
          "setColorScheme",
          "recordingStart",
        ]) {
          expect(
            Exit.isFailure(yield* Effect.exit(manager.checkAutomationControl("tab_1", operation))),
          ).toBe(true);
        }
        const pausedEpoch = (yield* manager.automationStatus("tab_1")).controlEpoch;
        for (const action of [
          manager.automationClick("tab_1", { x: 10, y: 10 }),
          manager.automationType("tab_1", { text: "do not enter this" }),
          manager.automationPress("tab_1", { key: "Enter" }),
          manager.automationScroll("tab_1", { deltaY: 100 }),
          manager.automationEvaluate("tab_1", { expression: "42" }),
          manager.navigate("tab_1", "https://example.com/agent", pausedEpoch),
          manager.setColorScheme("tab_1", "dark", pausedEpoch),
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(action))).toBe(true);
        }
        const pausedSnapshot = yield* manager.automationSnapshot("tab_1");
        expect(pausedSnapshot.automationControl).toBe("paused");
        expect(yield* manager.automationEvaluate("tab_2", { expression: "42" })).toBe(42);
        yield* manager.setAutomationPaused("tab_1", false);
        expect((yield* manager.automationStatus("tab_1")).automationControl).toBe("needs-snapshot");
        expect(
          Exit.isFailure(
            yield* Effect.exit(manager.automationEvaluate("tab_1", { expression: "42" })),
          ),
        ).toBe(true);
        const snapshot = yield* manager.automationSnapshot("tab_1");
        expect(snapshot.visibleText).toBe("Current page");
        expect(snapshot.automationControl).toBe("ready");
        // A delayed request from before takeover stays invalid even after the fresh snapshot.
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              manager.automationEvaluate("tab_1", { expression: "42" }, originalEpoch),
            ),
          ),
        ).toBe(true);
        expect(yield* manager.automationEvaluate("tab_1", { expression: "42" })).toBe(42);
        expect(tabs.get(42)?.getURL()).toBe("https://example.com");
        // Closing a tab must invalidate its epoch even if that runtime ID is recreated.
        const resumedEpoch = (yield* manager.automationStatus("tab_1")).controlEpoch;
        yield* manager.closeTab("tab_1");
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              manager.automationEvaluate("tab_1", { expression: "42" }, resumedEpoch),
            ),
          ),
        ).toBe(true);
      }),
    ),
  );

  effectIt.effect(
    "rejects running and queued actions after takeover without releasing the human's control",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let controller = "none";
          yield* manager.subscribeStateChanges((_id, state) =>
            Effect.sync(() => {
              controller = state.controller;
            }),
          );
          const wc = makeTestPreviewWebContents(vi.fn());
          Object.assign(wc, { isDevToolsOpened: () => false });
          const expressions: string[] = [];
          Object.assign(wc.debugger, {
            sendCommand: vi.fn(async (method: string, params?: { expression?: string }) => {
              if (method !== "Runtime.evaluate") return {};
              if (params?.expression === "running") {
                entered.resolve();
                await release.promise;
              }
              expressions.push(params?.expression ?? "");
              return { result: { value: 42 } };
            }),
          });
          fromId.mockReturnValue(wc);
          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          const running = yield* manager
            .automationEvaluate("tab_1", { expression: "running" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => entered.promise);
          // This fiber begins before takeover and waits on the tab's control permit.
          const waiting = yield* manager
            .automationEvaluate("tab_1", { expression: "queued" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* manager.setAutomationPaused("tab_1", true);
          release.resolve();
          expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true);
          expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true);
          expect(expressions).not.toContain("queued");
          expect(controller).toBe("human");
          expect((yield* manager.automationStatus("tab_1")).automationControl).toBe("paused");
        }),
      ),
  );

  effectIt.effect("saves downloads from agent-driven pages without a Save dialog", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((event: unknown, signal?: unknown) => void) | undefined;
        const wc = makeTestPreviewWebContents(async () => ({
          toPNG: () => Buffer.from("png"),
          toJPEG: () => Buffer.from("jpeg"),
          getSize: () => ({ width: 100, height: 80 }),
        }));
        Object.assign(wc, {
          isDevToolsOpened: () => false,
          loadURL: vi.fn(async () => undefined),
          reload: vi.fn(),
        });
        Object.assign(wc.ipc, {
          on: vi.fn((channel: string, listener: typeof humanInput) => {
            if (channel === "preview:human-input") humanInput = listener;
          }),
        });
        let holdEvaluate = false;
        let releaseEvaluate: (() => void) | undefined;
        Object.assign(wc.debugger, {
          sendCommand: vi.fn(async (method: string, params?: { expression?: string }) => {
            if (method !== "Runtime.evaluate") return undefined;
            if (params?.expression?.includes("matched"))
              return { result: { value: { matched: true } } };
            if (holdEvaluate) {
              holdEvaluate = false;
              await new Promise<void>((resolve) => {
                releaseEvaluate = resolve;
              });
            }
            return { result: { value: 42 } };
          }),
        });
        fromId.mockReturnValue(wc);
        const takeovers = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        let takeoverCount = 0;
        let controller = "none";
        yield* manager.subscribeStateChanges((_tabId, state) => {
          const takeover =
            controller !== "human" && state.controller === "human"
              ? takeovers[takeoverCount++]
              : undefined;
          controller = state.controller;
          return takeover ? Deferred.succeed(takeover, undefined).pipe(Effect.asVoid) : Effect.void;
        });
        yield* manager.getBrowserSession();
        yield* manager.getBrowserSession();
        const installs = previewSession.on.mock.calls.filter(
          ([event]) => event === "will-download",
        );
        expect(installs).toHaveLength(1);
        const willDownload = installs[0]![1] as (
          event: unknown,
          item: {
            getFilename: () => string;
            getStartTime: () => number;
            setSavePath: (path: string) => void;
          },
          source: Electron.WebContents,
        ) => void;
        const download = () => {
          const setSavePath = vi.fn();
          willDownload(
            {},
            { getFilename: () => "chart.png", getStartTime: () => 1_790_844_530.5, setSavePath },
            wc,
          );
          return setSavePath;
        };
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(download()).not.toHaveBeenCalled();

        yield* manager.automationEvaluate("tab_1", { expression: "42" });
        const startedAt = (1_790_844_530_500).toString(36);
        expect(download()).toHaveBeenCalledWith(
          `/tmp/t3/dev/browser-artifacts/browser-download-${startedAt}-0-chart.png`,
        );
        // Same name, same millisecond: still a separate file.
        expect(download()).toHaveBeenCalledWith(
          `/tmp/t3/dev/browser-artifacts/browser-download-${startedAt}-1-chart.png`,
        );

        humanInput?.({}, { kind: "pointer", x: 10, y: 10, button: 0 });
        yield* Deferred.await(takeovers[0]!);
        expect(download()).not.toHaveBeenCalled();

        // An action still waiting for the page when the human takes over must
        // not mark it as agent-driven again.
        yield* manager.setAutomationPaused("tab_1", false);
        yield* manager.automationSnapshot("tab_1");
        holdEvaluate = true;
        const running = yield* manager
          .automationEvaluate("tab_1", { expression: "42" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* settle(() => releaseEvaluate !== undefined);
        const queued = yield* manager
          .automationEvaluate("tab_1", { expression: "42" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        humanInput?.({}, { kind: "pointer", x: 20, y: 20, button: 0 });
        yield* Deferred.await(takeovers[1]!);
        releaseEvaluate?.();
        yield* Fiber.await(running);
        expect(Exit.isFailure(yield* Fiber.await(queued))).toBe(true);
        expect(download()).not.toHaveBeenCalled();

        yield* manager.setAutomationPaused("tab_1", false);
        yield* manager.automationSnapshot("tab_1");
        // URL-bar navigation hands the page back to the human.
        yield* manager.automationEvaluate("tab_1", { expression: "42" });
        expect(download()).toHaveBeenCalled();
        yield* manager.navigate("tab_1", "https://example.com/report.csv");
        expect(download()).not.toHaveBeenCalled();

        // Reading the page does not make it agent-driven.
        yield* manager.automationWaitFor("tab_1", { text: "Example" });
        expect(download()).not.toHaveBeenCalled();
      }),
    ),
  );
});

describe("PreviewOperationError", () => {
  it("keeps timeline detail separate from its structured message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new PreviewManager.PreviewOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "tab_1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});

describe("Preview automation diagnostics", () => {
  it("keeps browser exception detail out of structural diagnostics", () => {
    const secret = "unrelated-browser-payload-secret";
    const detail = "ReferenceError: missingValue is not defined";
    const cause = {
      text: "Uncaught Error",
      exception: { description: detail },
      unsafePayload: secret,
    };
    const error = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: "tab_1",
      detailKind: "exception-description",
      detailLength: detail.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error.message).toBe("Preview JavaScript evaluation failed in tab tab_1");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(encodedDiagnostics)).not.toContain(secret);
    expect("detail" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).toBe(detail);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).not.toContain(
      secret,
    );
  });

  it("retains bounded selector diagnostics without exposing selector or reason text", () => {
    const selector = "role=button[name='selector-secret']";
    const reason = "Unexpected token near reason-secret";
    const cause = { invalidSelector: true as const, message: reason };
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_1",
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error).toMatchObject({
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
    });
    expect(error.detail).toEqual({
      selectorKind: "locator",
      selectorLength: selector.length,
    });
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(encodedDiagnostics)).not.toContain("secret");
    expect("selector" in error).toBe(false);
    expect("reason" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(error)).toBe(
      reason,
    );
  });

  it("does not retain a missing target locator", () => {
    const selector = "[data-token='target-secret']";
    const error = new PreviewManager.PreviewAutomationTargetNotFoundError({
      operation: "scroll",
      tabId: "tab_1",
      selectorKind: "selector",
      selectorLength: selector.length,
    });

    expect(error.message).not.toContain(selector);
    expect(JSON.stringify(error)).not.toContain(selector);
    expect("locator" in error).toBe(false);
  });
});

describe("saved login page protection", () => {
  const login = {
    id: "login",
    name: "Example",
    origin: "https://example.com",
    username: "me",
    password: "fixture-secret",
    partition: "/tmp/test-profile",
    allowAgent: true,
  };

  effectIt.effect(
    "blocks page tools and captures while filled, survives Resume and in-page navigation",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents({
            url: login.origin + "/login",
            rasterize: async () => "submitted",
          });
          fromId.mockReturnValue(preview.webContents);
          yield* manager.createTab("password-tab");
          yield* manager.registerWebview("password-tab", 42);
          const epoch = (yield* manager.automationStatus("password-tab")).controlEpoch;
          expect(yield* manager.fillPassword("password-tab", login, 42, true, epoch)).toEqual({
            status: "submitted",
          });
          expect((yield* manager.automationStatus("password-tab")).title).toBe(
            "Sign-in in progress",
          );
          expect((yield* manager.automationStatus("password-tab")).url).toBe(login.origin);
          yield* manager.setAutomationPaused("password-tab", false);
          preview.listeners.get("did-navigate-in-page")!();
          for (const operation of [
            "snapshot",
            "evaluate",
            "click",
            "type",
            "scroll",
            "press",
            "waitFor",
            "recordingStart",
            "signIn",
          ]) {
            const failure = yield* manager
              .checkAutomationControl("password-tab", operation)
              .pipe(Effect.flip, Effect.orDie);
            expect(failure.message).toContain("autofilled login");
          }
          yield* manager.captureScreenshot("password-tab").pipe(Effect.flip, Effect.orDie);
          yield* manager.pickElement("password-tab").pipe(Effect.flip, Effect.orDie);
          yield* manager.openPictureInPicture("password-tab").pipe(Effect.flip, Effect.orDie);
          const navigated = yield* Deferred.make<void>();
          yield* manager.subscribeStateChanges((_id, state) =>
            state.navStatus.kind === "Success" && state.navStatus.url === login.origin + "/home"
              ? Deferred.succeed(navigated, undefined).pipe(Effect.asVoid)
              : Effect.void,
          );
          preview.setUrl(login.origin + "/home");
          preview.listeners.get("did-navigate")!();
          yield* Deferred.await(navigated);
          yield* manager.checkAutomationControl("password-tab", "snapshot");
          expect((yield* manager.automationStatus("password-tab")).url).toBe(
            login.origin + "/home",
          );
        }),
      ),
  );

  effectIt.effect("rejects changed origins, profiles and webviews before filling", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents({ url: login.origin });
        fromId.mockReturnValue(preview.webContents);
        yield* manager.createTab("password-tab");
        yield* manager.registerWebview("password-tab", 42);
        for (const changed of [
          { ...login, origin: "https://other.example" },
          { ...login, partition: "/tmp/other-profile" },
        ]) {
          yield* manager
            .fillPassword("password-tab", changed, 42, true)
            .pipe(Effect.flip, Effect.orDie);
        }
        yield* manager
          .fillPassword("password-tab", login, 43, true)
          .pipe(Effect.flip, Effect.orDie);
        expect(preview.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("requires a reload after arbitrary agent JavaScript", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents({
          url: login.origin,
          rasterize: async () => "submitted",
        });
        fromId.mockReturnValue(preview.webContents);
        yield* manager.createTab("password-tab");
        yield* manager.registerWebview("password-tab", 42);
        Object.assign((preview.webContents as Electron.WebContents).debugger, {
          sendCommand: vi.fn(async () => ({ result: { value: 42 } })),
        });
        yield* manager.automationEvaluate("password-tab", { expression: "42" });
        const failure = yield* manager
          .fillPassword("password-tab", login, 42, true)
          .pipe(Effect.flip, Effect.orDie);
        expect(failure.message).toContain("Reload this page");
        expect(preview.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
        preview.listeners.get("did-navigate")!();
        expect(yield* manager.fillPassword("password-tab", login, 42, true)).toEqual({
          status: "submitted",
        });
      }),
    ),
  );

  effectIt.effect("does not expose exceptions containing the credential", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents({
          url: login.origin,
          rasterize: async () => {
            throw new Error(login.password);
          },
        });
        fromId.mockReturnValue(preview.webContents);
        yield* manager.createTab("password-tab");
        yield* manager.registerWebview("password-tab", 42);
        const failure = yield* manager
          .fillPassword("password-tab", login, 42, true)
          .pipe(Effect.flip, Effect.orDie);
        expect(encodePreviewManagerError(failure)).not.toHaveProperty("cause");
        expect(String(failure)).not.toContain(login.password);
        yield* manager
          .checkAutomationControl("password-tab", "snapshot")
          .pipe(Effect.flip, Effect.orDie);
      }),
    ),
  );
});

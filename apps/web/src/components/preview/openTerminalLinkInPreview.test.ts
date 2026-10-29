import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openTerminalLinkInPreview } from "./openTerminalLinkInPreview";

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readPreparedConnection: () => ({ httpBaseUrl: "http://localhost:3773" }),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  rememberPreviewUrl: vi.fn(),
  readThreadPreviewState: () => ({ sessions: {} }),
  isPreviewSupportedInRuntime: () => true,
}));

vi.mock("~/rightPanelStore", () => ({
  selectSelectedRightPanelSurface: () => null,
  useRightPanelStore: {
    getState: () => ({ byThreadKey: {}, openBrowser: vi.fn(), getUserActionRevision: () => 0 }),
  },
}));

const browserDefaultsMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: browserDefaultsMocks.resolve,
}));

const linkTargetMocks = vi.hoisted(() => ({
  preference: vi.fn<() => "system" | "app">(),
}));

vi.mock("~/browser/browserLinkTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browser/browserLinkTarget")>()),
  resolveBrowserLinkTargetPreference: async () => linkTargetMocks.preference(),
}));

const hydratedDefaults = {
  viewport: { _tag: "fixed", width: 1280, height: 720 } as const,
  profileId: "work",
};

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-20T00:00:00.000Z",
};

beforeEach(() => {
  browserDefaultsMocks.resolve.mockReset();
  browserDefaultsMocks.resolve.mockResolvedValue(hydratedDefaults);
  linkTargetMocks.preference.mockReturnValue("app");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openTerminalLinkInPreview", () => {
  it("opens local links in the Workbench even with the system browser preference", async () => {
    linkTargetMocks.preference.mockReturnValue("system");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "http://localhost:3000/",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(fallbackToBrowser).not.toHaveBeenCalled();
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it("keeps public links in the configured system browser", async () => {
    linkTargetMocks.preference.mockReturnValue("system");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });
    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("reports a local preview failure without unexpectedly launching another browser", async () => {
    const failure = new Error("Server cannot be reached");
    const fallbackToBrowser = vi.fn();
    await expect(
      openTerminalLinkInPreview({
        url: "http://localhost:5173/",
        threadRef,
        openPreview: async () => AsyncResult.failure(Cause.fail(failure)),
        fallbackToBrowser,
        forceBrowser: false,
      }),
    ).rejects.toBe(failure);
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("does not report or fall back when opening the preview is interrupted", async () => {
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.interrupt()),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/docs", "http://localhost:5173/"])(
    "opens %s in the system browser when Ctrl or Command is held",
    async (url) => {
      const fallbackToBrowser = vi.fn();
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

      await openTerminalLinkInPreview({
        url,
        threadRef,
        openPreview,
        fallbackToBrowser,
        forceBrowser: true,
      });

      expect(fallbackToBrowser).toHaveBeenCalledOnce();
      expect(openPreview).not.toHaveBeenCalled();
    },
  );
});

import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openTerminalLinkInPreview,
  TerminalLinkPreviewOpenError,
} from "./openTerminalLinkInPreview";

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
  useRightPanelStore: {
    getState: () => ({ openBrowser: vi.fn(), getUserActionRevision: () => 0 }),
  },
}));

const browserDefaultsMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: browserDefaultsMocks.resolve,
  browserDefaultOpenViewport: (defaults: { viewport: unknown }) => defaults.viewport,
  browserDefaultOpenProfileId: (defaults: { profileId: string }) => defaults.profileId,
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
  it.each(["target", "defaults"] as const)(
    "does not open either browser when reading %s fails",
    async (setting) => {
      const failure = new Error("Settings read failed");
      if (setting === "target") {
        linkTargetMocks.preference.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        browserDefaultsMocks.resolve.mockRejectedValueOnce(failure);
      }
      const fallbackToBrowser = vi.fn();
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

      await expect(
        openTerminalLinkInPreview({
          url: "https://example.com/docs",
          threadRef,
          openPreview,
          fallbackToBrowser,
          forceBrowser: false,
        }),
      ).rejects.toBe(failure);
      expect(fallbackToBrowser).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
    },
  );

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

  it("opens public URLs in-app too, not only local servers", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(openPreview).toHaveBeenCalledOnce();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("waits for hydrated viewport and profile defaults before opening", async () => {
    let hydrate: ((defaults: typeof hydratedDefaults) => void) | undefined;
    browserDefaultsMocks.resolve.mockImplementationOnce(
      () =>
        new Promise<typeof hydratedDefaults>((resolve) => {
          hydrate = resolve;
        }),
    );
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    const opening = openTerminalLinkInPreview({
      url: "http://localhost:3000/",
      threadRef,
      openPreview,
      fallbackToBrowser: vi.fn(),
      forceBrowser: false,
    });

    await vi.waitFor(() => expect(browserDefaultsMocks.resolve).toHaveBeenCalledOnce());
    expect(openPreview).not.toHaveBeenCalled();
    hydrate?.(hydratedDefaults);
    await opening;

    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        threadId: "thread-1",
        url: "http://localhost:3000/",
        viewport: hydratedDefaults.viewport,
        profileId: hydratedDefaults.profileId,
      },
    });
  });

  it("preserves the complete preview failure cause before falling back", async () => {
    const rpcError = new Error("preview unavailable");
    const cause = Cause.combine(Cause.fail(rpcError), Cause.die("preview defect"));
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview: async () => AsyncResult.failure(cause),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    const error = reportError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(TerminalLinkPreviewOpenError);
    expect(error).toMatchObject({
      environmentId: "local",
      threadId: "thread-1",
      targetOrigin: "https://example.com",
      cause,
    });
    expect(error.message).not.toContain("preview unavailable");
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

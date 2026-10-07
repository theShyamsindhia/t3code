import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_CLIENT_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as browserDefaults from "~/browser/browserDefaults";
import { BrowserSettingsReadError, openUrlInPreview } from "~/browser/openFileInPreview";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { openPreviewSession } from "./openPreviewSession";

const bridge = vi.hoisted(() => ({ navigate: vi.fn(), refresh: vi.fn() }));
const connection = vi.hoisted(() => ({ httpBaseUrl: "http://localhost:3773" }));
vi.mock("./previewBridge", () => ({ previewBridge: bridge }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readPreparedConnection: () => connection,
}));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Loading",
    url: "https://t3.chat/",
    title: "",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-11T23:00:00.000Z",
};

beforeEach(() => {
  resetPreviewStateForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  bridge.navigate.mockReset();
  bridge.refresh.mockReset();
  connection.httpBaseUrl = "http://localhost:3773";
});

describe("local development previews", () => {
  const localSnapshot: PreviewSessionSnapshot = {
    ...snapshot,
    navStatus: {
      _tag: "Success",
      url: "http://localhost:5173/checkout?step=2#details",
      title: "Checkout",
    },
  };
  const openPreview = vi.fn(async () => AsyncResult.success(localSnapshot));

  beforeEach(() => openPreview.mockClear());

  it.each(["http://localhost:5173/", "localhost:5173"])(
    "reuses a server tab and preserves its current route when reopening %s",
    async (url) => {
      applyPreviewServerSnapshot(threadRef, localSnapshot);
      const result = await openUrlInPreview({
        threadRef,
        url,
        openPreview,
      });
      expect(result._tag).toBe("Success");
      expect(openPreview).not.toHaveBeenCalled();
      expect(bridge.navigate).not.toHaveBeenCalled();
      expect(bridge.refresh).not.toHaveBeenCalled();
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toMatchObject({ resourceId: localSnapshot.tabId });
      expect(readThreadPreviewState(threadRef).sessions[localSnapshot.tabId]?.navStatus).toEqual(
        localSnapshot.navStatus,
      );
    },
  );

  it("navigates an explicit deep link in the existing server tab", async () => {
    applyPreviewServerSnapshot(threadRef, localSnapshot);
    const url = "http://localhost:5173/settings?tab=profile#name";
    await openUrlInPreview({ threadRef, url, openPreview });
    expect(openPreview).not.toHaveBeenCalled();
    expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith(
      previewRuntimeTabId(threadRef, null, localSnapshot.tabId),
      url,
    );
  });

  it("retries a failed page in the same tab after a server restarts", async () => {
    applyPreviewServerSnapshot(threadRef, {
      ...localSnapshot,
      navStatus: {
        _tag: "LoadFailed",
        url: "http://localhost:5173/checkout",
        title: "",
        code: -102,
        description: "Connection refused",
      },
    });
    await openUrlInPreview({ threadRef, url: "http://localhost:5173/", openPreview });
    expect(openPreview).not.toHaveBeenCalled();
    expect(bridge.refresh).toHaveBeenCalledExactlyOnceWith(
      previewRuntimeTabId(threadRef, null, localSnapshot.tabId),
    );
  });

  it.each(["port", "profile", "thread", "environment", "protocol"])(
    "does not reuse a tab from another %s",
    async (difference) => {
      const otherRef = {
        ...threadRef,
        ...(difference === "thread"
          ? { threadId: "another-thread" as ScopedThreadRef["threadId"] }
          : {}),
        ...(difference === "environment"
          ? { environmentId: "another-environment" as ScopedThreadRef["environmentId"] }
          : {}),
      };
      applyPreviewServerSnapshot(otherRef, {
        ...localSnapshot,
        ...(difference === "profile" ? { profileId: "other-profile" } : {}),
        navStatus: {
          _tag: "Success",
          title: "Other app",
          url:
            difference === "port"
              ? "http://localhost:5174/"
              : difference === "protocol"
                ? "https://localhost:5173/"
                : "http://localhost:5173/",
        },
      });
      await openUrlInPreview({ threadRef, url: "http://localhost:5173/", openPreview });
      expect(openPreview).toHaveBeenCalledOnce();
      expect(bridge.navigate).not.toHaveBeenCalled();
    },
  );

  it("resolves a remote terminal's localhost against its own environment", async () => {
    connection.httpBaseUrl = "http://100.65.180.100:3773";
    await openUrlInPreview({
      threadRef,
      url: "http://localhost:5173/checkout?step=2#details",
      openPreview,
    });
    expect(openPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          url: "http://100.65.180.100:5173/checkout?step=2#details",
        }),
      }),
    );
  });

  it("does not open the client's localhost when a remote relay cannot reach the server", async () => {
    connection.httpBaseUrl = "https://relay.example.com";
    const result = await openUrlInPreview({
      threadRef,
      url: "http://localhost:5173/",
      openPreview,
    });
    expect(result._tag).toBe("Failure");
    expect(openPreview).not.toHaveBeenCalled();
    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  it("deduplicates clicks while the first server tab is still opening", async () => {
    let complete!: (value: ReturnType<typeof AsyncResult.success<PreviewSessionSnapshot>>) => void;
    const opening = new Promise<ReturnType<typeof AsyncResult.success<PreviewSessionSnapshot>>>(
      (resolve) => {
        complete = resolve;
      },
    );
    const open = vi.fn(() => opening);
    const first = openUrlInPreview({ threadRef, url: "http://localhost:5173/", openPreview: open });
    const second = openUrlInPreview({
      threadRef,
      url: "http://localhost:5173/",
      openPreview: open,
    });
    complete(AsyncResult.success(localSnapshot));
    await Promise.all([first, second]);
    expect(open).toHaveBeenCalledOnce();
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual([localSnapshot.tabId]);
  });

  it("keeps a newer panel choice while a preview open is pending", async () => {
    const open = async () => {
      useRightPanelStore.getState().open(threadRef, "files");
      return AsyncResult.success(localSnapshot);
    };
    await openUrlInPreview({ threadRef, url: "http://localhost:5173/", openPreview: open });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.kind,
    ).toBe("files");
    expect(readThreadPreviewState(threadRef).sessions[localSnapshot.tabId]).toEqual(localSnapshot);
  });

  it("releases a failed open so the next click can retry", async () => {
    const open = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Unavailable"))))
      .mockResolvedValueOnce(AsyncResult.success(localSnapshot));
    const input = { threadRef, url: "http://localhost:5173/", openPreview: open };
    expect((await openUrlInPreview(input))._tag).toBe("Failure");
    expect((await openUrlInPreview(input))._tag).toBe("Success");
    expect(open).toHaveBeenCalledTimes(2);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openPreviewSession", () => {
  it("creates an idle tab without recording a recently visited URL", async () => {
    const idleSnapshot: PreviewSessionSnapshot = {
      ...snapshot,
      tabId: "tab-blank",
      navStatus: { _tag: "Idle" },
    };
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(idleSnapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(idleSnapshot);
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
  });

  it("applies the RPC response without waiting for a preview event", async () => {
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
      url: "t3.chat",
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "t3.chat",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual(["https://t3.chat/"]);
  });

  it("returns failures without mutating preview state", async () => {
    const failure = new Error("preview unavailable");

    const result = await openPreviewSession({
      openPreview: async () => AsyncResult.failure(Cause.fail(failure)),
      threadRef,
      url: "t3.chat",
    });

    expect(result._tag).toBe("Failure");
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
  });

  it.each(["session", "link"] as const)(
    "does not open a %s with unread settings and uses the saved profile on retry",
    async (entryPoint) => {
      const failure = new Error("Settings read failed");
      vi.spyOn(browserDefaults, "resolveBrowserDefaults").mockRejectedValueOnce(failure);
      const viewport = { _tag: "freeform", width: 1280, height: 720 } as const;
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultViewport: viewport,
        browserDefaultProfileId: "work",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const input = { openPreview, threadRef, url: "https://t3.chat/" };
      const open = entryPoint === "session" ? openPreviewSession : openUrlInPreview;

      const result = await open(input);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Cause.squash(result.cause)).toBeInstanceOf(BrowserSettingsReadError);
        expect(Cause.squash(result.cause)).toMatchObject({ cause: failure });
      }
      expect(openPreview).not.toHaveBeenCalled();
      expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
      expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);

      await expect(open(input)).resolves.toMatchObject({ _tag: "Success" });
      expect(openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: input.url,
          viewport,
          profileId: "work",
        },
      });
    },
  );
});

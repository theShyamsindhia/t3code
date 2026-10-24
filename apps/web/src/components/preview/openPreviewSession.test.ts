import { setActivePreviewTab } from "~/previewStateStore";
import {
  DEFAULT_CLIENT_SETTINGS,
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
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
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

describe("openUrlInPreview from a link", () => {
  // regression: #16961 a background link open switched the active preview tab
  it("keeps the current tab active for a background open", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });

    await openUrlInPreview({
      openPreview: async () => AsyncResult.success(snapshot),
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    const state = readThreadPreviewState(threadRef);
    expect(state.activeTabId).toBe("tab-current");
    expect(Object.keys(state.sessions).toSorted()).toEqual(["tab-1", "tab-current"]);
  });

  it("keeps a tab the user picked while a background open was in flight", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-other" });
    setActivePreviewTab(threadRef, "tab-current");

    await openUrlInPreview({
      openPreview: async () => {
        applyPreviewServerSnapshot(threadRef, snapshot);
        setActivePreviewTab(threadRef, "tab-other");
        return AsyncResult.success(snapshot);
      },
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-other");
  });
});

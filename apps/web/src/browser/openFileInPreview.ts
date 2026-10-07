import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { DEFAULT_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
  readThreadPreviewState,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewBridge } from "~/components/preview/previewBridge";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { isLocalServerUrl } from "./browserLinkTarget";
import { resolveLocalServerUrl } from "./browserTargetResolver";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "./browserDefaults";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export class BrowserSettingsReadError extends Data.TaggedError("BrowserSettingsReadError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "Saved browser settings could not be loaded.";
  }
}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

interface OpenUrlInPreviewInput<E> {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}

// A second click can arrive before the first open RPC publishes its tab.
const pendingLocalPreviews = new Map<string, Promise<void>>();

export async function openUrlInPreview<E>(
  input: OpenUrlInPreviewInput<E>,
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  if (!isLocalServerUrl(input.url)) return openUrlInPreviewOnce(input, false);
  const key = scopedThreadKey(input.threadRef);
  while (pendingLocalPreviews.has(key)) await pendingLocalPreviews.get(key);
  const opening = openUrlInPreviewOnce(input, true);
  pendingLocalPreviews.set(
    key,
    opening.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await opening;
  } finally {
    pendingLocalPreviews.delete(key);
  }
}

async function openUrlInPreviewOnce<E>(
  input: OpenUrlInPreviewInput<E>,
  localServer: boolean,
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const panelRevision = useRightPanelStore.getState().getUserActionRevision(input.threadRef);
  const showTab = (tabId: string) => {
    const panel = useRightPanelStore.getState();
    // A slow open must not replace a surface the user selected while waiting.
    if (panel.getUserActionRevision(input.threadRef) === panelRevision) {
      panel.openBrowser(input.threadRef, tabId);
    }
  };
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const profileId = browserDefaultOpenProfileId(defaults);
  let url = input.url;
  try {
    if (localServer) url = resolveLocalServerUrl(input.threadRef.environmentId, input.url);
  } catch (cause) {
    return AsyncResult.failure(Cause.die(cause));
  }
  if (localServer && previewBridge) {
    const state = readThreadPreviewState(input.threadRef);
    const target = new URL(url);
    const existing = [state.snapshot, ...Object.values(state.sessions)].find(
      (session) =>
        session !== null &&
        (session.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId &&
        session.navStatus._tag !== "Idle" &&
        new URL(session.navStatus.url).origin === target.origin,
    );
    if (existing && existing.navStatus._tag !== "Idle") {
      const runtimeTabId = previewRuntimeTabId(input.threadRef, state.serverEpoch, existing.tabId);
      // A server's root link brings back the page being tested. A deep link
      // explicitly requests navigation; failed pages can retry in the same tab.
      const isRoot =
        target.pathname === "/" &&
        !target.search &&
        !target.hash &&
        !target.username &&
        !target.password;
      try {
        if (!isRoot && existing.navStatus.url !== url) {
          await previewBridge.navigate(runtimeTabId, url);
        } else if (existing.navStatus._tag === "LoadFailed") {
          await previewBridge.refresh(runtimeTabId);
        }
      } catch (cause) {
        return AsyncResult.failure(Cause.die(cause));
      }
      showTab(existing.tabId);
      return AsyncResult.success(undefined);
    }
  }
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      url,
      // Built here rather than via `openPreviewSession` because this path
      // maps the result differently, so the configured defaults have to be
      // applied explicitly or file/link opens would ignore them.
      viewport: browserDefaultOpenViewport(defaults),
      profileId,
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, url);
    showTab(snapshot.tabId);
  });
}

/**
 * Opens a browser document in the integrated browser. Inside the workspace the
 * page may load sibling assets; a file outside it is served on its own.
 */
export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserSettingsReadError
  >
> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: insideWorkspace ? "workspace-file" : "media-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  // Documents served by the local T3 server are independent tabs, not dev apps.
  return openUrlInPreviewOnce(
    { threadRef: input.threadRef, url: assetUrl, openPreview: input.openPreview },
    false,
  );
}

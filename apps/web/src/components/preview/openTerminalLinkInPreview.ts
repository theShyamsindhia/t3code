import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import {
  isLocalServerUrl,
  resolveLinkTarget,
  resolveBrowserLinkTargetPreference,
} from "~/browser/browserLinkTarget";
import {
  BrowserSettingsReadError,
  openUrlInPreview,
  type OpenPreviewMutation,
} from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";

const terminalLinkErrorContext = {
  environmentId: Schema.String,
  threadId: Schema.String,
  targetOrigin: Schema.String,
  cause: Schema.Defect(),
};

export class TerminalLinkPreviewOpenError extends Schema.TaggedError<TerminalLinkPreviewOpenError>()(
  "TerminalLinkPreviewOpenError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    return `Failed to open terminal link ${this.targetOrigin} in preview for thread ${this.threadId}.`;
  }
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly fallbackToBrowser: () => void;
  /** Cmd/Ctrl-click bypasses the preference and opens in the system browser. */
  readonly forceBrowser: boolean;
}

/**
 * Local server links open beside the terminal; other URLs follow the saved
 * preference. Cmd/Ctrl-click explicitly requests the system browser.
 */
export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  if (input.forceBrowser || !isPreviewSupportedInRuntime() || !input.threadRef.threadId) {
    input.fallbackToBrowser();
    return;
  }
  const target = resolveLinkTarget({
    url: input.url,
    event: { metaKey: false, ctrlKey: false },
    preference: await resolveBrowserLinkTargetPreference(),
    canOpenInApp: true,
  });
  if (target === "system") {
    input.fallbackToBrowser();
    return;
  }

  const errorContext = {
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    targetOrigin: new URL(input.url).origin,
  };

  const result = await openUrlInPreview(input);
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const failure = squashAtomCommandFailure(result);
    if (failure instanceof BrowserSettingsReadError) throw failure.cause;
    if (isLocalServerUrl(input.url)) throw failure;
    console.error(
      new TerminalLinkPreviewOpenError({
        ...errorContext,
        cause: result.cause,
      }),
    );
    input.fallbackToBrowser();
    return;
  }
  recordVisitForThread(input.threadRef, input.url);
}

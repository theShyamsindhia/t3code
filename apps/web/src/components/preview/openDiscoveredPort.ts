import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  openUrlInPreview,
  type BrowserSettingsReadError,
  type OpenPreviewMutation,
} from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";

export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const result = await openUrlInPreview({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: input.port.url,
  });
  return mapAtomCommandResult(result, () => {
    recordVisitForThread(input.threadRef, input.port.url);
  });
}

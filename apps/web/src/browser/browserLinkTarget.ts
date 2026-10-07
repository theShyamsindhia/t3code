/**
 * Where a link clicked inside a thread should open.
 *
 * Settings → Integrations → Browser lets the user choose between the OS
 * default browser and a tab in the in-app browser. This module turns that
 * preference plus the click and local-server URL into one answer, so chat markdown and the
 * terminal drawer make the same decision and offer the same escape hatch.
 *
 * @module browserLinkTarget
 */
import type { BrowserLinkTarget } from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";

export interface ResolveLinkTargetInput {
  readonly url: string;
  /** Cmd/Ctrl-click always goes to the system browser, whatever the default. */
  readonly event: { readonly metaKey: boolean; readonly ctrlKey: boolean };
  readonly preference: BrowserLinkTarget;
  /** Whether this client has an in-app browser and a thread to open it beside. */
  readonly canOpenInApp: boolean;
}

/**
 * Local development links stay beside the conversation. Other links follow
 * the saved preference; modifier clicks always request the system browser.
 */
export function resolveLinkTarget(input: ResolveLinkTargetInput): BrowserLinkTarget {
  if (input.event.metaKey || input.event.ctrlKey) return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  return isLocalServerUrl(input.url) ? "app" : input.preference;
}

export function isLocalServerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(normalizePreviewUrl(rawUrl));
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Only http(s) can load in the in-app browser. Anything else — mailto:,
 * vscode://, a bare fragment — belongs to the shell whatever the preference.
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The configured default, once client settings have actually loaded. Before
 * hydration the snapshot is the schema default ("system"), so a link clicked
 * in the first moments after launch would ignore a persisted "app" — opening
 * is asynchronous anyway, so waiting costs nothing the user can see.
 * Read failures reject rather than choosing a browser without the saved preference.
 */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

/** Whether the in-app target is available at all in this client. */
export function canOpenLinksInApp(hasThread: boolean): boolean {
  return hasThread && isPreviewSupportedInRuntime();
}

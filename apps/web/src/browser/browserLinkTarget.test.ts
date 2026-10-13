import type { BrowserLinkTarget } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

import { resolveBrowserLinkTargetPreference, resolveLinkTarget } from "./browserLinkTarget";

const settings = vi.hoisted(() => ({ browserLinkTarget: "system" as BrowserLinkTarget }));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => settings,
}));

const click = { metaKey: false, ctrlKey: false };

describe("resolveLinkTarget", () => {
  it.each([
    "http://localhost:5173/",
    "http://127.0.0.1:3000/app",
    "http://0.0.0.0:8080/",
    "https://[::1]:8443/",
  ])("keeps local server %s in the Workbench with the system default", (url) => {
    expect(resolveLinkTarget({ url, event: click, preference: "system", canOpenInApp: true })).toBe(
      "app",
    );
    expect(
      resolveLinkTarget({ url, event: click, preference: "system", canOpenInApp: false }),
    ).toBe("system");
    expect(
      resolveLinkTarget({
        url,
        event: { ...click, metaKey: true },
        preference: "system",
        canOpenInApp: true,
      }),
    ).toBe("system");
    expect(
      resolveLinkTarget({
        url,
        event: { ...click, ctrlKey: true },
        preference: "system",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it.each([
    "http://localhost.example.com:3000/",
    "https://localhost@outside.example/",
    "http://192.168.1.25:3000/",
  ])("does not mistake %s for a local server", (url) => {
    expect(resolveLinkTarget({ url, event: click, preference: "system", canOpenInApp: true })).toBe(
      "system",
    );
  });

  it("keeps the system browser unless the user asked for in-app", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "system",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it("opens in-app when asked and the runtime can", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("app");
  });

  it("falls back to the system browser where there is no in-app browser", () => {
    // The hosted web app and mobile have nowhere to open a tab, so the
    // preference cannot be honoured there and the link still has to open.
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: false,
      }),
    ).toBe("system");
  });

  it("treats a modifier click as the way out of the in-app default", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: true, ctrlKey: false },
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("system");
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: false, ctrlKey: true },
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it("leaves non-web schemes to the shell", () => {
    for (const url of ["mailto:someone@example.com", "vscode://file/x", "not a url"]) {
      expect(resolveLinkTarget({ url, event: click, preference: "app", canOpenInApp: true })).toBe(
        "system",
      );
    }
  });
});

describe("resolveBrowserLinkTargetPreference", () => {
  it.each(["system", "app"] as const)(
    "rejects failed reads instead of using the current %s preference",
    async (preference) => {
      settings.browserLinkTarget = preference;
      const failure = new Error("Settings read failed");
      vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(failure);

      await expect(resolveBrowserLinkTargetPreference()).rejects.toBe(failure);
      await expect(resolveBrowserLinkTargetPreference()).resolves.toBe(preference);
    },
  );
});

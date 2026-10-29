import type { BrowserLinkTarget } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveLinkTarget } from "./browserLinkTarget";

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

  it("leaves non-web schemes to the shell", () => {
    for (const url of ["mailto:someone@example.com", "vscode://file/x", "not a url"]) {
      expect(resolveLinkTarget({ url, event: click, preference: "app", canOpenInApp: true })).toBe(
        "system",
      );
    }
  });
});

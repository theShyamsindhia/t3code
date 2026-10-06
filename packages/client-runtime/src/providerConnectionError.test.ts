import { describe, expect, it } from "vite-plus/test";
import { explainProviderConnectionError } from "./providerConnectionError.ts";

describe("explainProviderConnectionError", () => {
  it.each([
    "workspace routing discovery failed",
    "workspace routing discovery timed out",
    "CodexAppServerRequestError: workspace routing discovery failed",
  ])("explains %s without blaming the project folder", (message) => {
    expect(explainProviderConnectionError(message)).toEqual({
      label: "Codex couldn't connect",
      detail:
        "Codex couldn't reach ChatGPT to continue. Check your connection, then retry. If it keeps happening, try again shortly.",
    });
  });

  it.each([
    ["running", "Codex is reconnecting", "retrying automatically"],
    ["completed", "Codex reconnected", "connection recovered"],
    ["interrupted", "Codex reconnection stopped", "attempt was stopped"],
    ["cancelled", "Codex reconnection stopped", "attempt was stopped"],
  ] as const)("describes the %s state accurately", (status, label, detail) => {
    const result = explainProviderConnectionError("workspace routing discovery failed", status);
    expect(result?.label).toBe(label);
    expect(result?.detail).toContain(detail);
  });

  it.each([
    "Workspace folder no longer exists",
    "Invalid API key",
    "Usage limit reached",
    "Claude API overloaded",
    "An unknown provider error",
  ])("preserves unrelated errors: %s", (message) => {
    expect(explainProviderConnectionError(message)).toBeNull();
  });
});

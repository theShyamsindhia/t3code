import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Translate this known Codex routing error without guessing the cause of other failures. */
export function explainProviderConnectionError(
  message: string,
  status: OrchestrationV2TurnItem["status"] = "failed",
): { label: string; detail: string } | null {
  if (!/\bworkspace routing discovery (?:failed|timed out)\b/iu.test(message)) return null;

  switch (status) {
    case "running":
      return {
        label: "Codex is reconnecting",
        detail: "Codex is having trouble reaching ChatGPT. It is retrying automatically.",
      };
    case "completed":
      return {
        label: "Codex reconnected",
        detail: "The connection recovered and the turn continued.",
      };
    case "interrupted":
    case "cancelled":
      return {
        label: "Codex reconnection stopped",
        detail: "The connection attempt was stopped. You can retry when you are ready.",
      };
    default:
      return {
        label: "Codex couldn't connect",
        detail:
          "Codex couldn't reach ChatGPT to continue. Check your connection, then retry. If it keeps happening, try again shortly.",
      };
  }
}

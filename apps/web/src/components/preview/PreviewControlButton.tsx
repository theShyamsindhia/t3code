import type { PreviewAutomationControl } from "@t3tools/contracts";
import { Hand, Play } from "lucide-react";
import { useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { previewBridge } from "./previewBridge";

export function PreviewControlButton({
  tabId,
  control,
  controller,
}: {
  tabId: string;
  control: PreviewAutomationControl;
  controller: "human" | "agent" | "none";
}) {
  const [pending, setPending] = useState(false);
  const paused = control === "paused";
  const label = paused ? "Resume" : "Take over";
  const status = paused ? "You" : controller === "agent" ? "Agent" : "Ready";
  const Icon = paused ? Play : Hand;

  const toggle = async () => {
    if (!previewBridge || pending) return;
    setPending(true);
    try {
      await previewBridge.automation.setPaused(tabId, !paused);
    } catch {
      toastManager.add({ type: "error", title: "Couldn’t change browser control. Try again." });
    } finally {
      setPending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${status === "Ready" ? "Agent access ready" : `${status} has browser control`}. ${label}`}
            disabled={pending}
            onClick={() => void toggle()}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
        }
      >
        <Icon className="size-3" />
        {paused ? "You · " : controller === "agent" ? "Agent · " : ""}
        {label}
      </TooltipTrigger>
      <TooltipPopup>
        {paused
          ? "You’re in control. Resume lets the agent inspect this page and continue."
          : control === "needs-snapshot"
            ? "Agent access resumed. A fresh snapshot is required before its next action."
            : controller === "agent"
              ? "The agent is using this tab. Click or type in the page to take over."
              : "Agent access is ready. Take over to keep its actions paused in this tab."}
      </TooltipPopup>
    </Tooltip>
  );
}

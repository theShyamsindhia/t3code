import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { onOpenUsagePopover } from "../../usagePopoverBus";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarMenuButton, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageLimitsPooled } from "../usage/UsageLimitsPooled";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";

export function SidebarUsagePopover() {
  const [open, setOpen] = useState(false);
  const { setOpen: setSidebarOpen } = useSidebar();

  useEffect(
    () =>
      onOpenUsagePopover(() => {
        setSidebarOpen(true);
        setOpen(true);
      }),
    [setSidebarOpen],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <SidebarMenuButton aria-label="Usage" size="icon">
                  <ChartNoAxesColumnIcon />
                </SidebarMenuButton>
              }
            />
          }
        />
        <TooltipPopup side="top">Usage</TooltipPopup>
      </Tooltip>
      <PopoverPopup width="lg" side="top" align="end" sideOffset={12}>
        {open ? <UsagePopoverContent onClose={() => setOpen(false)} /> : null}
      </PopoverPopup>
    </Popover>
  );
}

function UsagePopoverContent({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const connected = [...presentations].filter(
    ([, presentation]) =>
      presentation.connection.phase === "connected" && presentation.serverConfig !== null,
  );
  const connectedKey = connected
    .map(([id]) => id)
    .sort()
    .join(",");
  const refresh = async (automatic = false) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.all(
        connected.map(([environmentId]) =>
          refreshUsageLimits(
            environmentId,
            () => refreshProviders({ environmentId, input: {} }),
            automatic,
          ),
        ),
      );
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      setNow(Date.now());
    }
  };
  const autoRefresh = useEffectEvent(() => void refresh(true));
  useEffect(() => {
    if (connectedKey) autoRefresh();
  }, [connectedKey]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <PopoverTitle>Usage</PopoverTitle>
          <span className="text-xs text-muted-foreground">All environments</span>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh limits"
          aria-busy={refreshing}
          disabled={refreshing || connected.length === 0}
          onClick={() => void refresh()}
        >
          <RefreshIcon size="sm" refreshing={refreshing} />
        </Button>
        <PopoverClose render={<Button size="icon-sm" variant="ghost" aria-label="Close usage" />}>
          <XIcon />
        </PopoverClose>
      </div>
      {presentations.size === 0 ? (
        <p className="text-sm text-muted-foreground">Connect an environment to see limits.</p>
      ) : (
        <UsageLimitsPooled compact presentations={presentations} now={now} />
      )}
      <div className="flex justify-end border-t border-border pt-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const preferences = readUsagePagePreferences();
            saveUsagePagePreferences({
              ...preferences,
              metric: preferences.metric === "limits" ? "cost" : preferences.metric,
            });
            onClose();
            void navigate({ to: "/usage" });
          }}
        >
          Cost & token details
        </Button>
      </div>
    </div>
  );
}

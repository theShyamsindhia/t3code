import type { PullRequestCheck } from "@t3tools/contracts";
import { CircleDotIcon, ExternalLinkIcon, HammerIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "../ui/button";
import { PullRequestCheckStatusIcon, pullRequestCheckStatusLabel } from "./pullRequestPresentation";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import { sortReviewChecks } from "./pullRequestReviewTrail.logic";

type ChecksProps = {
  checks: readonly PullRequestCheck[];
  stale: boolean;
  pendingFinding?: string | null | undefined;
  fixLabel: string;
  onFixFinding?: ((finding: PullRequestFinding) => void) | undefined;
  onOpen: (url: string) => void;
  onRefresh: () => void;
};

function StatusIcon({ status, stale }: { status: PullRequestCheck["status"]; stale: boolean }) {
  if (status === "pending" && !stale) {
    return (
      <LoaderCircleIcon
        aria-hidden
        className="size-4 shrink-0 text-warning-foreground motion-safe:animate-spin"
      />
    );
  }
  return status === "pending" ? (
    <CircleDotIcon aria-hidden className="size-4 shrink-0 text-warning-foreground" />
  ) : (
    <PullRequestCheckStatusIcon status={status} />
  );
}

function CheckCard({ check, ...props }: ChecksProps & { check: PullRequestCheck }) {
  const finding = { kind: "check", check } as const;
  const failing = check.status === "failure" || check.status === "cancelled";
  return (
    <article className="space-y-1.5 rounded-xl border border-border/60 bg-background px-3 py-2">
      <div className="flex items-start gap-2">
        <StatusIcon status={check.status} stale={props.stale} />
        <h3 className="min-w-0 flex-1 text-xs font-medium wrap-anywhere">{check.name}</h3>
        <p className="max-w-24 shrink-0 text-right text-xs text-muted-foreground">
          {props.stale ? "Last reported: " : ""}
          {pullRequestCheckStatusLabel(check)}
        </p>
        {check.url ? (
          <Button
            variant="ghost-muted"
            size="icon-tiny"
            aria-label={`Open ${check.name} check`}
            onClick={() => props.onOpen(check.url!)}
          >
            <ExternalLinkIcon />
          </Button>
        ) : null}
      </div>
      {check.required ? <p className="text-xs text-muted-foreground">Required</p> : null}
      {check.description ? (
        <p className="text-xs leading-relaxed text-muted-foreground wrap-anywhere">
          {check.description}
        </p>
      ) : null}
      {failing && !props.stale && props.onFixFinding ? (
        <Button
          variant="outline"
          size="xs"
          disabled={props.pendingFinding != null}
          onClick={() => props.onFixFinding?.(finding)}
        >
          <HammerIcon />
          {props.pendingFinding === pullRequestFindingKey(finding)
            ? "Preparing..."
            : props.fixLabel}
        </Button>
      ) : null}
    </article>
  );
}

export function PullRequestReviewChecks(props: ChecksProps) {
  const checks = sortReviewChecks(props.checks);
  const counts = new Map<PullRequestCheck["status"], number>();
  for (const check of props.checks) counts.set(check.status, (counts.get(check.status) ?? 0) + 1);
  const summary = (
    ["failure", "cancelled", "action-required", "pending", "success", "neutral", "skipped"] as const
  )
    .flatMap((status) => {
      const count = counts.get(status);
      return count
        ? [
            `${count} ${status === "action-required" ? "awaiting action" : pullRequestCheckStatusLabel({ status, url: null }).toLowerCase()}`,
          ]
        : [];
    })
    .join(" · ");
  return (
    <section
      aria-label="Checks"
      className="min-w-0 rounded-3xl border border-border/60 bg-card/30 p-4 @4xl:sticky @4xl:top-4"
    >
      <h2 className="text-sm font-semibold">Checks</h2>
      {props.stale ? (
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>Check details are out of date.</p>
          <Button variant="outline" size="xs" onClick={props.onRefresh}>
            Refresh checks
          </Button>
        </div>
      ) : null}
      <p className="mt-1 mb-4 text-xs text-muted-foreground">
        {props.stale && checks.length > 0 ? "Last reported: " : ""}
        {summary || "No checks reported."}
      </p>
      <div className="space-y-2">
        {checks.map((check, index) => (
          // Hosts may return multiple runs with the same name and URL.
          <CheckCard key={`${check.name}:${check.url ?? ""}:${index}`} {...props} check={check} />
        ))}
      </div>
    </section>
  );
}

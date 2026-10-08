import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestReviewThread,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  HammerIcon,
  MessageSquareIcon,
  RabbitIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { PullRequestConversationGhost } from "./PullRequestGhosts";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import {
  codeRabbitReviewState,
  isCodeRabbit,
  latestCodeRabbitActivityAt,
  newCodeRabbitActivity,
  reviewFindingPreview,
  reviewTrailGroups,
} from "./pullRequestReviewTrail.logic";

type TrailProps = {
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  activityPending: boolean;
  activityError: string | null;
  checksStale: boolean;
  pendingFinding?: string | null | undefined;
  fixFindingLabel: string;
  onFixFinding?: ((finding: PullRequestFinding) => void) | undefined;
  onRefresh: () => void;
};

function ReviewAge({ at }: { at: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={at} className="whitespace-nowrap tabular-nums" />}>
        {formatRelativeTimeLabel(at)}
      </TooltipTrigger>
      <TooltipPopup>{new Date(at).toLocaleString()}</TooltipPopup>
    </Tooltip>
  );
}

function Finding({
  thread,
  seenThrough,
  ...props
}: TrailProps & { thread: PullRequestReviewThread; seenThrough: string | null }) {
  const first = thread.comments[0];
  const preview = reviewFindingPreview(first?.body ?? "");
  const latestReply = thread.comments.length > 1 ? thread.comments.at(-1) : undefined;
  const finding = { kind: "thread", thread } as const;
  const newActivity = newCodeRabbitActivity(thread, seenThrough);
  return (
    <Collapsible>
      <div className="px-3 py-2.5">
        <CollapsibleTrigger className="group flex w-full items-start gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-lg">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              {preview.severity ? (
                <Badge
                  variant={
                    preview.severity === "Critical" || preview.severity === "Major"
                      ? "warning"
                      : "secondary"
                  }
                  size="control"
                >
                  {preview.severity}
                </Badge>
              ) : null}
              <p className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">{preview.title}</p>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {newActivity ? (
                <Tooltip>
                  <TooltipTrigger render={<Badge variant="secondary" size="sm" />}>
                    {newActivity === "finding" ? "New" : "New reply"}
                  </TooltipTrigger>
                  <TooltipPopup>
                    CodeRabbit added this {newActivity} since your previous visit.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              <Badge variant={thread.isResolved ? "success" : "warning"} size="sm">
                {thread.isResolved ? "Resolved" : "Open"}
              </Badge>
              {thread.isOutdated ? (
                <Tooltip>
                  <TooltipTrigger render={<span />}>Earlier version</TooltipTrigger>
                  <TooltipPopup>
                    The code location is stale. This does not mean the finding is resolved.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {first ? (
                <span>
                  Opened <ReviewAge at={first.createdAt} />
                </span>
              ) : null}
            </div>
            {preview.excerpt ? (
              <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-muted-foreground wrap-anywhere">
                {preview.excerpt}
              </p>
            ) : null}
          </div>
          <ChevronDownIcon
            aria-hidden
            className="mt-2 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180"
          />
        </CollapsibleTrigger>
        {latestReply ? (
          <div className="mt-1.5 flex min-w-0 gap-2 text-xs text-muted-foreground">
            <span className="shrink-0 font-medium">
              Reply ·{" "}
              {isCodeRabbit(latestReply.author?.login)
                ? "CodeRabbit"
                : (latestReply.author?.login ?? "Reviewer")}
              {" · "}
              <ReviewAge at={latestReply.createdAt} />
            </span>
            <p className="line-clamp-1 min-w-0 leading-relaxed wrap-anywhere">
              {reviewFindingPreview(latestReply.body).title}
            </p>
          </div>
        ) : null}
      </div>
      <CollapsiblePanel>
        <div className="space-y-4 border-t border-border/60 bg-muted/15 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {thread.isResolved ? "Thread resolved" : "Open thread"}
            {thread.isOutdated ? " · Earlier version" : ""}
          </p>
          {thread.comments.map((comment) => (
            <div key={comment.id} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <PullRequestActorLabel actor={comment.author} />
                <ReviewAge at={comment.createdAt} />
              </div>
              <PullRequestCommentBody
                text={comment.body}
                cwd={props.detail.workspaceRoot}
                environmentId={props.environmentId}
                threadRef={props.threadRef}
              />
            </div>
          ))}
          {thread.nextCommentsCursor ? (
            <p className="text-xs text-muted-foreground">More replies are available on the host.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {first?.url ? (
              <Button
                variant="outline"
                size="xs"
                render={<a href={first.url} target="_blank" rel="noopener noreferrer" />}
              >
                <ExternalLinkIcon />
                Open original thread
              </Button>
            ) : null}
            {!thread.isResolved && props.onFixFinding ? (
              <Button
                variant="outline"
                size="xs"
                disabled={props.pendingFinding != null}
                onClick={() => props.onFixFinding?.(finding)}
              >
                <HammerIcon />
                {props.pendingFinding === pullRequestFindingKey(finding)
                  ? "Preparing..."
                  : props.fixFindingLabel}
              </Button>
            ) : null}
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function PullRequestReviewTrail(props: TrailProps) {
  const { detail } = props;
  const seenKey = `t3:pr-review-seen:${props.environmentId}:${detail.viewer ?? ""}:${detail.url}`;
  const [seenThrough] = useState(() => {
    try {
      const saved = localStorage.getItem(seenKey);
      if (saved !== null && Number.isFinite(Date.parse(saved))) return saved;
    } catch {
      // This visit still tracks arrivals when local storage is unavailable.
    }
    return new Date().toISOString();
  });
  const latestActivityAt = latestCodeRabbitActivityAt(detail);
  // Keep this visit's baseline fixed. Updating the saved watermark affects the next visit only.
  useEffect(() => {
    if (props.activityPending || props.activityError) return;
    const watermark = latestActivityAt ?? seenThrough;
    try {
      localStorage.setItem(seenKey, seenThrough > watermark ? seenThrough : watermark);
    } catch {
      // Storage can be unavailable; the in-memory baseline still works for this visit.
    }
  }, [latestActivityAt, props.activityError, props.activityPending, seenKey, seenThrough]);
  const rabbit = codeRabbitReviewState(detail);
  const groups = reviewTrailGroups(detail.reviewThreads);
  const onlyRabbit =
    rabbit.present &&
    detail.reviewThreads.every((thread) => isCodeRabbit(thread.comments[0]?.author?.login));
  const open = detail.reviewThreads.filter((thread) => !thread.isResolved).length;
  const status = rabbit.check?.status;
  const statusLabel = props.checksStale
    ? "Status out of date"
    : status === "pending"
      ? rabbit.current
        ? "Reviewing latest commit"
        : "Review pending"
      : status === "success"
        ? "Review check passed"
        : status === "failure"
          ? "Review check failed"
          : status === "action-required"
            ? "Review needs action"
            : status === "cancelled"
              ? "Review cancelled"
              : status === "skipped"
                ? "Review skipped"
                : status === "neutral"
                  ? "Review check neutral"
                  : rabbit.present
                    ? "Review status unavailable"
                    : null;
  return (
    <section
      aria-label="Review trail"
      className="min-w-0 rounded-3xl border border-border/60 bg-card/30 p-3"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {onlyRabbit ? (
          <RabbitIcon aria-hidden className="size-5 text-muted-foreground" />
        ) : (
          <MessageSquareIcon aria-hidden className="size-5 text-muted-foreground" />
        )}
        <h2 className="text-sm font-semibold">{onlyRabbit ? "CodeRabbit" : "Review trail"}</h2>
        {statusLabel ? (
          <Badge variant={status === "pending" ? "warning" : "secondary"} size="control">
            {statusLabel}
          </Badge>
        ) : null}
        {rabbit.score && !props.activityPending && !props.activityError ? (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="outline" size="control" />}>
              Reported score {rabbit.score.value}/{rabbit.score.total}
            </TooltipTrigger>
            <TooltipPopup>
              CodeRabbit’s merge readiness score from its report. Check results are tracked
              separately.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {!props.activityPending && !props.activityError ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {detail.reviewThreadsTruncated ? "Loaded: " : ""}
            {open} open · {detail.reviewThreads.length - open} resolved
          </span>
        ) : null}
      </div>
      {props.activityPending ? (
        <PullRequestConversationGhost />
      ) : props.activityError ? (
        <PullRequestActivityUnavailableState
          compact
          error={props.activityError}
          onRetry={props.onRefresh}
        />
      ) : (
        <div className="space-y-3">
          {detail.reviewThreadsTruncated ? (
            <p className="text-xs text-muted-foreground">
              Only part of the review history is loaded. Open the original review for the rest.
            </p>
          ) : null}
          {groups.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No inline review threads yet. General reviews and reports are in Comments below.
            </p>
          ) : null}
          {groups.map((group) => (
            <div
              key={group.path}
              className="relative pl-6 before:absolute before:top-5 before:-bottom-8 before:left-2 before:w-px before:bg-border last:before:hidden"
            >
              {group.open === 0 ? (
                <CircleCheckIcon
                  aria-hidden
                  className="absolute -left-0.5 top-2.5 size-5 rounded-full bg-background text-success-foreground"
                />
              ) : (
                <CircleDotIcon
                  aria-hidden
                  className="absolute -left-0.5 top-2.5 size-5 rounded-full bg-background text-warning-foreground"
                />
              )}
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-background">
                <Collapsible defaultOpen>
                  <CollapsibleTrigger className="group flex w-full items-start gap-2 px-3 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium wrap-anywhere">{group.title}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {group.threads.length} {group.threads.length === 1 ? "finding" : "findings"}{" "}
                        · {group.open > 0 ? `${group.open} open` : "resolved"}
                      </p>
                      <p className="mt-0.5 font-mono text-3xs text-muted-foreground wrap-anywhere">
                        {group.path}
                      </p>
                    </div>
                    <ChevronDownIcon
                      aria-hidden
                      className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180"
                    />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="divide-y divide-border/60 border-t border-border/60">
                      {group.threads.map((thread) => (
                        <Finding
                          key={thread.id}
                          {...props}
                          thread={thread}
                          seenThrough={seenThrough}
                        />
                      ))}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </div>
            </div>
          ))}
          {rabbit.present ? (
            <div className="relative pl-6">
              <CircleDotIcon
                aria-hidden
                className="absolute -left-0.5 top-2.5 size-5 rounded-full bg-background text-muted-foreground"
              />
              <div
                className={cn(
                  "space-y-2 rounded-2xl border bg-background p-3",
                  status === "pending" && !props.checksStale
                    ? "border-warning/40"
                    : "border-border/70",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium">{statusLabel ?? "CodeRabbit review"}</h3>
                  {!onlyRabbit ? (
                    <span className="text-xs text-muted-foreground">CodeRabbit</span>
                  ) : null}
                  {detail.headSha ? (
                    <code className="text-xs text-muted-foreground">
                      Head: {detail.headSha.slice(0, 7)}
                    </code>
                  ) : null}
                </div>
                {latestActivityAt ? (
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    Latest review activity · <ReviewAge at={latestActivityAt} />
                    {latestActivityAt > seenThrough ? (
                      <Badge variant="secondary" size="sm">
                        New
                      </Badge>
                    ) : null}
                  </p>
                ) : null}
                {status === "pending" && !props.checksStale ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {open === 0 && detail.reviewThreads.length > 0
                      ? "Previous threads are resolved. "
                      : ""}
                    The current review has not finished.
                  </p>
                ) : null}
                {props.checksStale ? (
                  <Button variant="outline" size="xs" onClick={props.onRefresh}>
                    Refresh status
                  </Button>
                ) : null}
                {!props.checksStale && rabbit.files.length > 0 ? (
                  <div className="grid gap-2 @2xl:grid-cols-2">
                    {rabbit.files.map((path) => (
                      <div
                        key={path}
                        className="flex min-w-0 items-start gap-2 rounded-xl border border-border/60 px-3 py-2"
                      >
                        <FileCodeIcon
                          aria-hidden
                          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="text-xs wrap-anywhere">{path}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {rabbit.report?.url ? (
                  <Button
                    variant="ghost-muted"
                    size="xs"
                    render={
                      <a href={rabbit.report.url} target="_blank" rel="noopener noreferrer" />
                    }
                  >
                    <ExternalLinkIcon />
                    Original CodeRabbit report
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

import type {
  PullRequestCheck,
  PullRequestDetailView,
  PullRequestReviewThread,
} from "@t3tools/contracts";

export function isCodeRabbit(login: string | undefined): boolean {
  return /^(?:coderabbit|coderabbitai)(?:\[bot\])?$/i.test(login ?? "");
}

export function latestCodeRabbitActivityAt(
  detail: Pick<PullRequestDetailView, "comments" | "reviewThreads">,
): string | null {
  const dates = [
    ...detail.comments.filter((comment) => comment.kind !== "issue-comment"),
    ...detail.reviewThreads.flatMap((thread) => thread.comments),
  ]
    .filter((comment) => isCodeRabbit(comment.author?.login))
    .map((comment) => comment.createdAt);
  return dates.reduce<string | null>(
    (latest, at) => (latest === null || at > latest ? at : latest),
    null,
  );
}

export function newCodeRabbitActivity(
  thread: PullRequestReviewThread,
  seenThrough: string | null,
): "finding" | "reply" | null {
  if (seenThrough === null) return null;
  const firstNew = thread.comments.findIndex(
    (comment) => isCodeRabbit(comment.author?.login) && comment.createdAt > seenThrough,
  );
  return firstNew < 0 ? null : firstNew === 0 ? "finding" : "reply";
}

function plainText(text: string): string {
  const code: string[] = [];
  return text
    .replace(/`([^`]+)`/g, (_, value: string) => {
      code.push(value);
      return `\uE000${code.length - 1}\uE001`;
    })
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2")
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) => code[Number(index)] ?? "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A short excerpt, not a generated interpretation. The original thread stays available. */
export function reviewFindingPreview(body: string) {
  const introduction = body.replace(/<!--[^]*?-->/g, "").split(/<details\b/i)[0] ?? "";
  const severity = introduction.match(
    /(?:\*\*|_)[^\p{L}\p{N}\n]*\b(Critical|Major|Minor|Trivial)\s*(?:\*\*|_)/iu,
  )?.[1];
  const paragraphs = introduction
    .split(/\n\s*\n/)
    .map(plainText)
    .filter(Boolean)
    .filter(
      (text) =>
        !/^(?:[^\p{L}\p{N}]*Potential issue\b|.*\|.*\b(?:Critical|Major|Minor|Trivial)\b)/iu.test(
          text,
        ),
    );
  const title = paragraphs[0] ?? "Review comment";
  return {
    title: title.length > 160 ? `${title.slice(0, 157)}…` : title,
    excerpt:
      (paragraphs[1] ?? "").length > 280
        ? `${paragraphs[1]!.slice(0, 277)}…`
        : (paragraphs[1] ?? ""),
    severity: severity ? severity[0]!.toUpperCase() + severity.slice(1).toLowerCase() : null,
  };
}

/** Keep file identity and host resolution state; neither wording nor outdated lines resolve a thread. */
export function reviewTrailGroups(threads: readonly PullRequestReviewThread[]) {
  const groups = new Map<string, PullRequestReviewThread[]>();
  for (const thread of threads) {
    const key = thread.path;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  return [...groups].map(([path, group]) => ({
    path,
    title: path.split("/").at(-1) ?? path,
    threads: group,
    open: group.filter((thread) => !thread.isResolved).length,
    resolved: group.filter((thread) => thread.isResolved).length,
  }));
}

function reportedCodeRabbitScore(body: string) {
  const match = body.match(
    /^\s*#{1,6}\s+\*{0,2}Merge readiness score:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\*{0,2}\s*$/im,
  );
  if (!match) return null;
  const value = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && value <= total ? { value, total } : null;
}

/** Only the current check controls freshness; a bot's older "ready" prose is not current status. */
export function codeRabbitReviewState(
  detail: Pick<PullRequestDetailView, "checks" | "comments" | "headSha" | "reviewThreads">,
) {
  const checks = detail.checks.filter((check) => isCodeRabbit(check.name));
  const check = checks.find((entry) => entry.status !== "success") ?? checks[0];
  const report = detail.comments
    .filter((comment) => comment.kind === "issue-comment" && isCodeRabbit(comment.author?.login))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const progress = report?.body.match(
    /<!--[^>]*review in progress by coderabbit\.ai[^>]*-->([^]*?)<!-- end of auto-generated comment/i,
  )?.[1];
  const reviewingHead = progress?.match(
    /\bbetween\s+[a-f0-9]{7,40}\s+and\s+([a-f0-9]{7,40})\b/i,
  )?.[1];
  const current =
    check?.status === "pending" && reviewingHead !== undefined && reviewingHead === detail.headSha;
  const files = current
    ? [...(progress ?? "").matchAll(/^\s*>?\s*\* `([^`\n]+)`\s*$/gm)].map((match) => match[1]!)
    : [];
  return {
    checks,
    check,
    report,
    score: report ? reportedCodeRabbitScore(report.body) : null,
    files,
    current,
    present:
      checks.length > 0 ||
      detail.comments.some((comment) => isCodeRabbit(comment.author?.login)) ||
      detail.reviewThreads.some((thread) => isCodeRabbit(thread.comments[0]?.author?.login)),
  };
}

/** Put checks needing attention first without folding away any individual run. */
export function sortReviewChecks(checks: readonly PullRequestCheck[]) {
  const priority = {
    failure: 0,
    "action-required": 1,
    cancelled: 2,
    pending: 3,
    success: 4,
    neutral: 5,
    skipped: 6,
  };
  return [...checks].sort((a, b) => priority[a.status] - priority[b.status]);
}

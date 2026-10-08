import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  codeRabbitReviewState,
  isCodeRabbit,
  latestCodeRabbitActivityAt,
  newCodeRabbitActivity,
  sortReviewChecks,
  reviewFindingPreview,
  reviewTrailGroups,
} from "./pullRequestReviewTrail.logic";

function thread(id: string, path: string, resolved: boolean): PullRequestReviewThread {
  return {
    id,
    path,
    line: null,
    side: "right",
    isResolved: resolved,
    isOutdated: true,
    comments: [
      {
        id: `${id}-comment`,
        body: "**A finding.**\n\nDetails.",
        author: { login: "coderabbitai", name: null, avatarUrl: null },
        createdAt: "2026-10-08T10:00:00Z",
        url: null,
      },
    ],
  };
}
const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
});
const head = "e36090a542b7adaafd9af7f2c76c7c0c2bf6a3a5";
function report(body: string, login = "coderabbitai"): PullRequestComment {
  return {
    id: "report",
    kind: "issue-comment",
    author: { login, name: null, avatarUrl: null },
    body,
    createdAt: "2026-10-08T10:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  };
}
const processing = `<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->
> Reviewing files between 6320c13e8ced33a261998e9a7cb920885554c046 and ${head}.
> * \`tests/row-label.test.ts\`
<!-- end of auto-generated comment: review in progress by coderabbit.ai -->
Merge readiness: Ready`;

describe("review excerpts", () => {
  it("preserves identifiers and JSX in inline code", () => {
    expect(
      reviewFindingPreview('**Check `WHOLE_RESULT_PIPELINE`.**\n\nUse `<Row label="Works" />`.'),
    ).toEqual({
      title: "Check WHOLE_RESULT_PIPELINE.",
      excerpt: 'Use <Row label="Works" />.',
      severity: null,
    });
  });
  it("separates CodeRabbit metadata from the finding and omits bot instructions", () => {
    const preview = reviewFindingPreview(
      "**🎯 Functional Correctness** | **🟡 Minor** | **⚡ Quick win**\n\n**Reject newlines in the whole-result command.**\n\nA second command can fake the result.\n\n<details><summary>Prompt for AI Agents</summary>Do something unrelated.</details>",
    );
    expect(preview).toEqual({
      title: "Reject newlines in the whole-result command.",
      excerpt: "A second command can fake the result.",
      severity: "Minor",
    });
  });
  it("supports older metadata and ordinary human comments without inventing a severity", () => {
    expect(
      reviewFindingPreview(
        "_⚠️ Potential issue_ | _🟠 Major_\n\n**Check the destination.**\n\nUse `apps` only.",
      ),
    ).toEqual({ title: "Check the destination.", excerpt: "Use apps only.", severity: "Major" });
    expect(reviewFindingPreview("Please add a regression test.").severity).toBeNull();
  });
});

describe("review state", () => {
  it("reads the bot's reported score without changing a pending review or failed checks", () => {
    const result = codeRabbitReviewState({
      checks: [check("CodeRabbit", "pending"), check("Unit tests", "failure")],
      comments: [report("### **Merge readiness score: 4/5**")],
      reviewThreads: [],
    });
    expect(result.score).toEqual({ value: 4, total: 5 });
    expect(result.check?.status).toBe("pending");
  });
  it("does not invent a score from human comments, missing scores, or invalid ranges", () => {
    for (const comment of [
      report("### **Merge readiness score: 5/5**", "human"),
      report("### Merge readiness: Ready"),
      report("### Merge readiness score: 6/5"),
      report("### Merge readiness score: 4/0"),
    ]) {
      expect(
        codeRabbitReviewState({ checks: [], comments: [comment], reviewThreads: [] }).score,
      ).toBeNull();
    }
    expect(
      codeRabbitReviewState({
        checks: [],
        comments: [report("### Merge readiness score: 0/5")],
        reviewThreads: [],
      }).score,
    ).toEqual({ value: 0, total: 5 });
  });
  it("marks new bot findings and replies independently of resolution and stale locations", () => {
    const finding = thread("new", "one.ts", true);
    expect(newCodeRabbitActivity(finding, null)).toBeNull();
    expect(newCodeRabbitActivity(finding, "2026-10-08T09:00:00Z")).toBe("finding");
    expect(newCodeRabbitActivity(finding, "2026-10-08T10:00:00Z")).toBeNull();
    const reply = {
      ...finding.comments[0]!,
      id: "reply",
      createdAt: "2026-10-08T11:00:00Z",
    };
    const withReply = { ...finding, comments: [...finding.comments, reply] };
    expect(newCodeRabbitActivity(withReply, "2026-10-08T10:00:00Z")).toBe("reply");
    expect(
      newCodeRabbitActivity(
        {
          ...finding,
          comments: [
            ...finding.comments,
            { ...reply, author: { login: "human", name: null, avatarUrl: null } },
          ],
        },
        "2026-10-08T10:00:00Z",
      ),
    ).toBeNull();
  });
  it("uses bot review activity for age, not a human reply or an edited processing report", () => {
    const finding = thread("old", "one.ts", false);
    const review = {
      ...report("Review complete"),
      kind: "review" as const,
      createdAt: "2026-10-08T11:00:00Z",
    };
    expect(
      latestCodeRabbitActivityAt({
        comments: [review, { ...report(processing), createdAt: "2026-10-08T12:00:00Z" }],
        reviewThreads: [finding],
      }),
    ).toBe(review.createdAt);
    expect(latestCodeRabbitActivityAt({ comments: [], reviewThreads: [] })).toBeNull();
  });
  it("does not claim the latest commit is being reviewed when commit information is missing", () => {
    const result = codeRabbitReviewState({
      checks: [check("CodeRabbit", "pending")],
      comments: [],
      reviewThreads: [],
    });
    expect(result.current).toBe(false);
    expect(result.files).toEqual([]);
  });
  it("keeps resolved threads separate from a new pending review, ignoring older readiness prose", () => {
    const result = codeRabbitReviewState({
      checks: [check("CodeRabbit", "pending")],
      headSha: head,
      comments: [report(processing)],
      reviewThreads: [thread("a", "a.ts", true)],
    });
    expect(result.current).toBe(true);
    expect(result.files).toEqual(["tests/row-label.test.ts"]);
    expect(result.check?.status).toBe("pending");
    expect(reviewTrailGroups([thread("a", "a.ts", true)])[0]?.open).toBe(0);
  });
  it("does not attach an older processing report or a human-authored report to the current commit", () => {
    for (const comments of [
      [report(processing.replace(head, "a".repeat(40)))],
      [report(processing, "human")],
    ]) {
      const result = codeRabbitReviewState({
        checks: [check("CodeRabbit", "pending")],
        headSha: head,
        comments,
        reviewThreads: [],
      });
      expect(result.current).toBe(false);
      expect(result.files).toEqual([]);
    }
  });
  it("does not keep a completed check in a reviewing state because the report still says processing", () => {
    const result = codeRabbitReviewState({
      checks: [check("CodeRabbit", "success")],
      headSha: head,
      comments: [report(processing)],
      reviewThreads: [],
    });
    expect(result.current).toBe(false);
    expect(result.files).toEqual([]);
  });
  it("does not infer resolution from outdated lines and preserves files with identical basenames", () => {
    const groups = reviewTrailGroups([
      thread("a", "one/test.ts", true),
      thread("b", "one/test.ts", false),
      thread("c", "two/test.ts", true),
    ]);
    expect(groups.map(({ path, open, resolved }) => ({ path, open, resolved }))).toEqual([
      { path: "one/test.ts", open: 1, resolved: 1 },
      { path: "two/test.ts", open: 0, resolved: 1 },
    ]);
  });
  it("recognizes only the CodeRabbit identity, including GitHub's bot suffix", () => {
    expect(isCodeRabbit("CodeRabbitAI[bot]")).toBe(true);
    expect(isCodeRabbit("not-coderabbitai")).toBe(false);
    expect(isCodeRabbit("coderabbitai-helper")).toBe(false);
  });
});

it("prioritizes failures while preserving every shard and its status", () => {
  const checks = sortReviewChecks([
    check("Convex tests (1/4)", "success"),
    check("Convex tests (2/4)", "failure"),
    check("Convex tests (3/4)", "pending"),
    check("Convex tests (4/4)", "pending"),
    check("lint", "skipped"),
  ]);
  expect(checks.map(({ name, status }) => [name, status])).toEqual([
    ["Convex tests (2/4)", "failure"],
    ["Convex tests (3/4)", "pending"],
    ["Convex tests (4/4)", "pending"],
    ["Convex tests (1/4)", "success"],
    ["lint", "skipped"],
  ]);
});

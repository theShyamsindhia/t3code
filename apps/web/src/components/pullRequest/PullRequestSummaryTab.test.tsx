import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));

import { PullRequestSummaryTab } from "./PullRequestSummaryTab";

const detail: PullRequestDetailView = {
  provider: "github",
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function render(value = detail, checksStale = false) {
  return (
    <PullRequestSummaryTab
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      reference={value}
      detail={value}
      activityPending={false}
      activityError={null}
      checksStale={checksStale}
      onRefresh={() => {}}
    />
  );
}

function heading(title: string) {
  const section = renderer.root
    .findAllByType("section")
    .find((section) => section.props["aria-label"] === title)!;
  return section
    .findAllByType("button")
    .find((button) => button.findAllByType("span").some((span) => span.children.includes(title)))!;
}

function click(title: string) {
  act(() =>
    heading(title).props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }),
  );
}

it("shows passed checks and individual shards immediately and keeps them visible when switching PRs", () => {
  const value: PullRequestDetailView = {
    ...detail,
    checks: [
      ...detail.checks,
      { name: "Convex tests (1/2)", status: "pending", description: null, url: null },
      { name: "Convex tests (2/2)", status: "failure", description: null, url: null },
      { name: "CodeRabbit", status: "success", description: null, url: null },
    ],
  };
  act(() => {
    renderer = create(render(value));
  });
  const checkNames = () =>
    renderer.root
      .findByProps({ "aria-label": "Checks" })
      .findAllByType("h3")
      .map((heading) => heading.children.join(""));
  expect(checkNames()).toEqual([
    "Convex tests (2/2)",
    "Convex tests (1/2)",
    "Unit tests",
    "CodeRabbit",
  ]);
  act(() => renderer.update(render(value, true)));
  expect(checkNames()).toHaveLength(value.checks.length);
  expect(
    renderer.root
      .findAllByType("p")
      .some((node) => node.children.join("") === "Last reported: Passed"),
  ).toBe(true);
  click("Description");
  act(() =>
    renderer.update(render({ ...detail, url: "https://github.com/owner/repo/pull/2", number: 2 })),
  );
  expect(checkNames()).toEqual(["Unit tests"]);
  expect(heading("Description").props["aria-expanded"]).toBe(false);
});

it("keeps an unsaved description when collapsed and reopened", () => {
  act(() => {
    renderer = create(render());
  });
  click("Description");
  act(() => renderer.root.findByProps({ "aria-label": "Edit description" }).props.onClick());
  act(() =>
    renderer.root.findByType("textarea").props.onChange({
      target: { value: "Unsaved description" },
      currentTarget: { value: "Unsaved description" },
      nativeEvent: {},
    }),
  );
  click("Description");
  expect(heading("Description").props["aria-expanded"]).toBe(false);
  click("Description");
  expect(renderer.root.findByType("textarea").props.value).toBe("Unsaved description");
});

it("keeps new CodeRabbit activity visible through refreshes and clears it on the next visit", () => {
  const storage = new Map([
    [`t3:pr-review-seen:environment:author:${detail.url}`, "2026-09-01T00:00:00Z"],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const newReview: PullRequestDetailView = {
    ...detail,
    comments: [
      {
        id: "new-review",
        kind: "review",
        body: "No actionable findings.",
        author: { login: "coderabbitai", name: null, avatarUrl: null },
        createdAt: "2026-09-01T01:00:00Z",
        url: null,
        path: null,
        reviewState: "COMMENTED",
      },
    ],
  };
  const hasNew = () =>
    renderer.root.findAllByType("span").some((node) => node.children.includes("New"));
  act(() => {
    renderer = create(render());
  });
  expect(hasNew()).toBe(false);
  act(() => renderer.update(render(newReview)));
  expect(hasNew()).toBe(true);
  act(() => renderer.update(render({ ...newReview })));
  expect(hasNew()).toBe(true);
  act(() => renderer.unmount());
  act(() => {
    renderer = create(render(newReview));
  });
  expect(hasNew()).toBe(false);
});

it("opens bot reports in pages without hiding human comments", () => {
  const value: PullRequestDetailView = {
    ...detail,
    commentCount: 13,
    comments: Array.from({ length: 13 }, (_, index) => ({
      id: `comment-${index}`,
      kind: "issue-comment",
      author: {
        login: index === 12 ? "human" : "review-app",
        name: null,
        avatarUrl: null,
        isBot: index !== 12,
      },
      body: index === 12 ? "Human comment" : `Bot report ${index}`,
      createdAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}Z`,
      url: null,
      path: null,
      reviewState: null,
    })),
  };
  act(() => {
    renderer = create(render(value));
  });
  expect(renderer.root.findAllByType("p").map((p) => p.children.join(""))).toContain(
    "Human comment",
  );
  expect(
    renderer.root.findAllByType("p").some((p) => p.children.join("").startsWith("Bot report")),
  ).toBe(false);
  const group = renderer.root
    .findAllByType("button")
    .find((button) => button.props["aria-label"] === "12 bot comments")!;
  act(() => group.props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }));
  expect(
    renderer.root.findAllByType("p").filter((p) => p.children.join("").startsWith("Bot report")),
  ).toHaveLength(10);
  expect(renderer.root.findAllByType("p").map((p) => p.children.join(""))).not.toContain(
    "Bot report 0",
  );
  act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes(" older bot comment"))!
      .props.onClick(),
  );
  expect(
    renderer.root.findAllByType("p").filter((p) => p.children.join("").startsWith("Bot report")),
  ).toHaveLength(12);
  act(() => group.props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }));
  act(() => group.props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }));
  expect(renderer.root.findAllByType("p").map((p) => p.children.join(""))).toContain(
    "Bot report 0",
  );
  act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes(" recent bot comments"))!
      .props.onClick(),
  );
  expect(
    renderer.root.findAllByType("p").filter((p) => p.children.join("").startsWith("Bot report")),
  ).toHaveLength(10);
  act(() => renderer.update(render({ ...value, url: `${value.url}0`, number: 10 })));
  expect(
    renderer.root.findAllByType("p").some((p) => p.children.join("").startsWith("Bot report")),
  ).toBe(false);
});

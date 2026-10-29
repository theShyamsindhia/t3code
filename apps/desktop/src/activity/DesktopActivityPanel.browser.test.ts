import type { DesktopActivitySnapshot, DesktopActivityThread } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

// The module also holds the main-process panel; only its HTML renderer runs here.
vi.mock("electron", () => ({}));

import { activityContent } from "./DesktopActivityPanel.ts";

const thread = {
  environmentId: "remote" as DesktopActivityThread["environmentId"],
  threadId: "thread" as DesktopActivityThread["threadId"],
  title: "Review changes",
  project: "Project",
  environment: "Remote Mac",
  status: "approval",
} satisfies DesktopActivityThread;
const snapshot: DesktopActivitySnapshot = {
  threads: [thread],
  attentionCount: 1,
  workingCount: 0,
  unavailableCount: 0,
};

it("shows untrusted titles as text and preserves the remote destination", () => {
  const container = document.createElement("div");
  container.innerHTML = activityContent({
    ...snapshot,
    threads: [{ ...thread, title: '<img src=x onerror="bad()">', project: "A & B" }],
  });
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".title")?.textContent).toBe('<img src=x onerror="bad()">');
  expect(container.querySelector(".meta")?.textContent).toBe("A & B · Remote Mac");
  const url = new URL(container.querySelector("a")!.href);
  expect(url.searchParams.get("environmentId")).toBe("remote");
  expect(url.searchParams.get("threadId")).toBe("thread");
  expect(
    activityContent({ ...snapshot, threads: [], attentionCount: 0, unavailableCount: 1 }),
  ).toContain("Activity may be incomplete");
});

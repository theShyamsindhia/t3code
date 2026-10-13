// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { InteractionEditor, InteractionPanel } from "./InteractionPanel";
import type { InteractionPresentation } from "@t3tools/contracts";

const presentation: InteractionPresentation = {
  title: "Choose a direction",
  prompt: "Arrange these by what feels right.",
  groups: [{ id: "keep", label: "Keep" }],
  items: [
    { id: "a", label: "Quiet", detail: "Less interruption", groupId: "keep", emphasis: false },
    { id: "b", label: "Guided", detail: "More guidance", groupId: "keep", emphasis: false },
  ],
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button, [role=menuitem]"),
  ).find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

it("reorders, undoes, retains failed replies, and blocks duplicate submission", async () => {
  const submit = vi
    .fn<(text: string) => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  await act(async () =>
    root.render(
      <InteractionEditor
        storageKey="draft"
        presentation={presentation}
        disabled={false}
        onSubmit={submit}
      />,
    ),
  );
  await click("Move Guided up");
  expect(
    Array.from(container.querySelectorAll("article")).map((element) =>
      element.getAttribute("aria-label"),
    ),
  ).toEqual(["Guided", "Quiet"]);
  await click("Undo");
  expect(container.querySelector("article")?.getAttribute("aria-label")).toBe("Quiet");
  await click("Move Quiet down");
  await click("Send arrangement");
  expect(container.textContent).toContain("Couldn’t send yet");
  expect(submit.mock.calls[0]?.[0]).toContain("Keep:\n1. Guided [b]\n2. Quiet [a]");
  await click("Send arrangement");
  expect(container.textContent).toContain("Sent to this chat.");
  expect(button("Sent").disabled).toBe(true);
  expect(submit).toHaveBeenCalledTimes(2);
});

it("flushes drafts when closed, restores on reopen, and isolates conversations", async () => {
  const submit = vi.fn().mockResolvedValue(true);
  await act(async () =>
    root.render(
      <InteractionEditor
        key="a"
        storageKey="env:thread:a"
        presentation={presentation}
        disabled={false}
        onSubmit={submit}
      />,
    ),
  );
  await click("Move Guided up");
  await act(async () =>
    root.render(
      <InteractionEditor
        key="b"
        storageKey="env:thread:b"
        presentation={presentation}
        disabled={false}
        onSubmit={submit}
      />,
    ),
  );
  expect(container.querySelector("article")?.getAttribute("aria-label")).toBe("Quiet");
  await act(async () =>
    root.render(
      <InteractionEditor
        key="a"
        storageKey="env:thread:a"
        presentation={presentation}
        disabled={false}
        onSubmit={submit}
      />,
    ),
  );
  expect(container.querySelector("article")?.getAttribute("aria-label")).toBe("Guided");
});

it("keeps the current arrangement open when the agent offers another presentation", async () => {
  const props = { threadKey: "thread", disabled: false, onSubmit: vi.fn().mockResolvedValue(true) };
  await act(async () =>
    root.render(<InteractionPanel {...props} presentations={[{ id: "one", presentation }]} />),
  );
  await click("Move Guided up");
  await act(async () =>
    root.render(
      <InteractionPanel
        {...props}
        presentations={[
          { id: "one", presentation },
          { id: "two", presentation: { ...presentation, title: "New directions" } },
        ]}
      />,
    ),
  );
  expect(container.querySelector("h2")?.textContent).toBe("Choose a direction");
  expect(container.querySelector("article")?.getAttribute("aria-label")).toBe("Guided");
});

it("sends a drag-to-group arrangement with the user's notes intact", async () => {
  localStorage.setItem(
    "draft",
    JSON.stringify({
      groups: presentation.groups,
      items: presentation.items.map((item) => ({
        id: item.id,
        groupId: item.groupId,
        note: item.id === "a" ? "Only while I am focused" : "",
      })),
      note: "Let me change my mind later",
    }),
  );
  const submit = vi.fn().mockResolvedValue(true);
  await act(async () =>
    root.render(
      <InteractionEditor
        storageKey="draft"
        presentation={presentation}
        disabled={false}
        onSubmit={submit}
      />,
    ),
  );
  const drag = new Event("dragstart", { bubbles: true });
  Object.defineProperty(drag, "dataTransfer", { value: { setData: vi.fn(), effectAllowed: "" } });
  await act(async () =>
    container.querySelector('article[aria-label="Quiet"]')!.dispatchEvent(drag),
  );
  await act(async () =>
    container
      .querySelector('section[aria-label="Unsorted"]')!
      .dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })),
  );
  await click("Send arrangement");
  expect(submit.mock.calls[0]?.[0]).toContain(
    "Unsorted:\n1. Quiet [a]\n   My note: Only while I am focused",
  );
  expect(submit.mock.calls[0]?.[0]).toContain("My note: Let me change my mind later");
});

it("keeps notes when hidden and allows undoing a reset from the options menu", async () => {
  const submit = vi.fn().mockResolvedValue(true);
  await act(async () =>
    root.render(
      <InteractionEditor
        storageKey="draft"
        presentation={presentation}
        disabled={false}
        onSubmit={submit}
      />,
    ),
  );
  expect(container.querySelector("textarea")).toBeNull();
  await click("Add a note");
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Only while learning",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Hide note");
  expect(container.querySelector("textarea")).toBeNull();
  await click("Arrangement options");
  await click("Reset arrangement");
  await click("Undo");
  await click("Edit note");
  expect(container.querySelector("textarea")?.value).toBe("Only while learning");
  await click("Hide note");
  await click("Send arrangement");
  expect(submit.mock.calls[0]?.[0]).toContain("My note: Only while learning");
});

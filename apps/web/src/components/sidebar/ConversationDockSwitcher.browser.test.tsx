import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { DraftId } from "../../composerDraftStore";
import { ConversationDockSwitcher, type DockSwitcherEntry } from "./ConversationDockSwitcher";

const entries: DockSwitcherEntry[] = ["a", "b", "c"].map((key) => ({
  kind: "draft",
  key: `draft:${key}`,
  draftId: DraftId.make(key),
  title: `Chat ${key}`,
  project: "Preview project",
  text: `Unsent work for ${key}`,
}));

function Harness({ onSelect }: { onSelect: (entry: DockSwitcherEntry) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  return (
    <>
      <textarea aria-label="Composer" />
      <ConversationDockSwitcher
        listRef={listRef}
        getEntries={() => entries}
        activeKey="draft:a"
        onSelect={onSelect}
      />
      <ul ref={listRef}>
        {entries.map((entry) => (
          <li key={entry.key} data-thread-item="">
            <div role="button" tabIndex={0} data-conversation-dock-row={entry.key}>
              <span>{entry.title}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

type TestAnimation = { finished: Promise<void>; cancel: () => void; finish: () => void };

async function mountDock({ reducedMotion = true } = {}) {
  await using stack = new AsyncDisposableStack();
  stack.use(stubGlobal("matchMedia", () => ({ matches: reducedMotion })));
  // Real animations settle on the compositor's clock; these finish only when a test says so,
  // which is how a collapse can land after its pill was raised again.
  const animations: TestAnimation[] = [];
  stack.use(
    vi.spyOn(Element.prototype, "animate").mockImplementation(() => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const animation = { finished, cancel: vi.fn(), finish };
      animations.push(animation);
      return animation as never;
    }),
  );
  // Unmounting starts collapse animations; settle them before the spy goes away.
  stack.defer(() => act(() => animations.forEach((animation) => animation.finish())));
  const onSelect = vi.fn<(entry: DockSwitcherEntry) => void>();
  const screen = stack.use(await render(<Harness onSelect={onSelect} />));
  const composer = screen.container.querySelector("textarea")!;
  composer.focus();

  const owned = stack.move();
  return {
    container: screen.container,
    composer,
    animations,
    onSelect,
    row: (key: string) =>
      screen.container.querySelector<HTMLElement>(`[data-conversation-dock-row="draft:${key}"]`)!,
    key: (type: "keydown" | "keyup", value: string) =>
      act(() => {
        composer.dispatchEvent(
          new KeyboardEvent(type, { key: value, ctrlKey: type === "keydown", bubbles: true }),
        );
      }),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe("dock pill previews", () => {
  it("expands the existing pill without replacing its title or moving composer focus", async () => {
    await using dock = await mountDock();
    const { container, row, key } = dock;
    const pill = row("b");
    const title = pill.firstElementChild;
    const neighbors = [row("a"), row("c")];
    await key("keydown", "Tab");
    expect(row("b")).toBe(pill);
    expect(pill.firstElementChild).toBe(title);
    expect(pill.textContent).toContain("Unsent work for b");
    expect(pill.matches(":popover-open")).toBe(true);
    expect(neighbors.map((node) => node.textContent)).toEqual(["Chat a", "Chat c"]);
    expect(document.activeElement).toBe(dock.composer);
    expect(container.querySelectorAll("[data-dock-pill-preview]")).toHaveLength(1);
    expect(dock.onSelect).not.toHaveBeenCalled();

    await key("keydown", "Tab");
    expect(pill.textContent).toBe("Chat b");
    expect(row("c").textContent).toContain("Unsent work for c");
    await key("keyup", "Control");
    expect(dock.onSelect).toHaveBeenCalledExactlyOnceWith(entries[2]);
    expect(container.querySelector("[data-dock-pill-preview]")).toBeNull();
    expect(container.querySelector("[popover]")).toBeNull();
    expect(dock.animations).toHaveLength(0);
  });

  it("collapses on Escape without switching or losing the original pill", async () => {
    await using dock = await mountDock();
    const { row, key } = dock;
    const pill = row("b");
    await key("keydown", "Tab");
    await key("keydown", "Escape");
    await key("keyup", "Control");
    expect(row("b")).toBe(pill);
    expect(pill.textContent).toBe("Chat b");
    expect(pill.hasAttribute("popover")).toBe(false);
    expect(dock.onSelect).not.toHaveBeenCalled();
  });

  it("keeps a quickly revisited pill raised when its earlier collapse finishes", async () => {
    await using dock = await mountDock({ reducedMotion: false });
    const { container, row, key, animations } = dock;
    await key("keydown", "Tab"); // b
    await key("keydown", "Tab"); // c, b collapses
    const oldCollapse = animations[1]!;
    await key("keydown", "Tab"); // a
    await key("keydown", "Tab"); // b again
    await act(() => oldCollapse.finish());
    expect(row("b").hasAttribute("popover")).toBe(true);
    expect(row("b").matches(":popover-open")).toBe(true);
    expect(row("b").textContent).toContain("Unsent work for b");
    await key("keyup", "Control");
    await act(() => animations.forEach((animation) => animation.finish()));
    expect(container.querySelector("[popover]")).toBeNull();
    expect(dock.onSelect).toHaveBeenCalledExactlyOnceWith(entries[1]);
  });
});

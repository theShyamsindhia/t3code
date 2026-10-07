// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

describe("dock pill previews", () => {
  let root: Root;
  let container: HTMLDivElement;
  let reducedMotion = true;
  let animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[];
  const onSelect = vi.fn();

  function Harness() {
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
  const row = (key: string) =>
    container.querySelector<HTMLElement>(`[data-conversation-dock-row="draft:${key}"]`)!;
  async function key(type: "keydown" | "keyup", value: string) {
    await act(() => {
      container
        .querySelector("textarea")!
        .dispatchEvent(
          new KeyboardEvent(type, { key: value, ctrlKey: type === "keydown", bubbles: true }),
        );
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    reducedMotion = true;
    animations = [];
    onSelect.mockClear();
    vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(300, 700, 200, 28),
    );
    // jsdom has no top layer or animation clock; keep their lifecycle explicit.
    Object.defineProperties(HTMLElement.prototype, {
      scrollIntoView: { configurable: true, value: vi.fn() },
      showPopover: {
        configurable: true,
        value() {
          this.dataset.testPopoverOpen = "";
        },
      },
      hidePopover: {
        configurable: true,
        value() {
          delete this.dataset.testPopoverOpen;
        },
      },
      animate: {
        configurable: true,
        value() {
          let finish!: () => void;
          const finished = new Promise<void>((resolve) => {
            finish = resolve;
          });
          const animation = { finished, cancel: vi.fn(), finish };
          animations.push(animation);
          return animation;
        },
      },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => root.render(<Harness />));
    container.querySelector("textarea")!.focus();
  });

  afterEach(async () => {
    await act(() => root.unmount());
    await act(() => animations.forEach((animation) => animation.finish()));
    container.remove();
    for (const name of ["scrollIntoView", "showPopover", "hidePopover", "animate"]) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("expands the existing pill without replacing its title or moving composer focus", async () => {
    const pill = row("b");
    const title = pill.firstElementChild;
    const neighbors = [row("a"), row("c")];
    await key("keydown", "Tab");
    expect(row("b")).toBe(pill);
    expect(pill.firstElementChild).toBe(title);
    expect(pill.textContent).toContain("Unsent work for b");
    expect(neighbors.map((node) => node.textContent)).toEqual(["Chat a", "Chat c"]);
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    expect(container.querySelectorAll("[data-dock-pill-preview]")).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();

    await key("keydown", "Tab");
    expect(pill.textContent).toBe("Chat b");
    expect(row("c").textContent).toContain("Unsent work for c");
    await key("keyup", "Control");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(entries[2]);
    expect(container.querySelector("[data-dock-pill-preview]")).toBeNull();
    expect(container.querySelector("[popover]")).toBeNull();
    expect(animations).toHaveLength(0);
  });

  it("collapses on Escape without switching or losing the original pill", async () => {
    const pill = row("b");
    await key("keydown", "Tab");
    await key("keydown", "Escape");
    await key("keyup", "Control");
    expect(row("b")).toBe(pill);
    expect(pill.textContent).toBe("Chat b");
    expect(pill.hasAttribute("popover")).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps a quickly revisited pill raised when its earlier collapse finishes", async () => {
    reducedMotion = false;
    await key("keydown", "Tab"); // b
    await key("keydown", "Tab"); // c, b collapses
    const oldCollapse = animations[1]!;
    await key("keydown", "Tab"); // a
    await key("keydown", "Tab"); // b again
    await act(() => oldCollapse.finish());
    expect(row("b").hasAttribute("popover")).toBe(true);
    expect(row("b").textContent).toContain("Unsent work for b");
    await key("keyup", "Control");
    await act(() => animations.forEach((animation) => animation.finish()));
    expect(container.querySelector("[popover]")).toBeNull();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(entries[1]);
  });
});

import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { useConversationDockSwitcher } from "./useConversationDockSwitcher";

type Entry = { key: string };
type Choice = ReturnType<typeof useConversationDockSwitcher<Entry>>;

function Harness(props: {
  currentKey: string | null;
  getEntries: () => readonly Entry[];
  onSelect: (entry: Entry) => void;
  onChoice: (choice: Choice) => void;
}) {
  const { onChoice } = props;
  const currentChoice = useConversationDockSwitcher({
    getEntries: props.getEntries,
    activeKey: props.currentKey,
    onSelect: props.onSelect,
  });
  useLayoutEffect(() => {
    onChoice(currentChoice);
  }, [currentChoice, onChoice]);
  return <textarea aria-label="Composer" />;
}

async function mountSwitcher() {
  await using stack = new AsyncDisposableStack();
  let nativeAction: ((action: string) => void) | undefined;
  stack.use(
    stubGlobal("desktopBridge", {
      onMenuAction: (listener: (action: string) => void) => {
        nativeAction = listener;
        return () => {};
      },
    }),
  );
  const dock = {
    entries: [{ key: "a" }, { key: "b" }, { key: "c" }] as readonly Entry[],
    choice: null as Choice,
  };
  const getEntries = vi.fn(() => dock.entries);
  const onSelect = vi.fn<(entry: Entry) => void>();
  const onChoice = (choice: Choice) => {
    dock.choice = choice;
  };
  const harness = (currentKey: string | null) => (
    <Harness
      currentKey={currentKey}
      getEntries={getEntries}
      onSelect={onSelect}
      onChoice={onChoice}
    />
  );
  const screen = stack.use(await render(harness("a")));

  const owned = stack.move();
  return Object.assign(dock, {
    container: screen.container,
    getEntries,
    onSelect,
    route: (currentKey: string | null) => screen.rerender(harness(currentKey)),
    nativeAction: (action: string) => act(() => nativeAction?.(action)),
    async key(type: "keydown" | "keyup", key: string, options: KeyboardEventInit = {}) {
      const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...options });
      await act(() => {
        screen.container.querySelector("textarea")!.dispatchEvent(event);
      });
      return event;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  });
}

describe("dock chat switching", () => {
  it("previews without navigating, freezes order, then opens on Control release", async () => {
    await using dock = await mountSwitcher();
    expect(dock.getEntries).not.toHaveBeenCalled();
    expect((await dock.key("keydown", "Tab", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(dock.choice?.entries[dock.choice.index]?.key).toBe("b");
    expect(dock.onSelect).not.toHaveBeenCalled();
    dock.entries = [{ key: "c" }, { key: "new" }, { key: "a" }];
    await dock.route("a");
    await dock.key("keydown", "Tab", { ctrlKey: true });
    expect(dock.choice?.entries.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
    expect(dock.getEntries).toHaveBeenCalledTimes(1);
    await dock.key("keyup", "Tab", { ctrlKey: true });
    expect(dock.onSelect).not.toHaveBeenCalled();
    await dock.key("keyup", "Control");
    expect(dock.onSelect).toHaveBeenCalledExactlyOnceWith({ key: "c" });
    expect(dock.choice).toBeNull();
  });

  it("wraps both ways and accepts deliberate key repeats", async () => {
    await using dock = await mountSwitcher();
    await dock.key("keydown", "Tab", { ctrlKey: true, shiftKey: true });
    expect(dock.choice?.index).toBe(2);
    await dock.key("keydown", "Tab", { ctrlKey: true, repeat: true });
    expect(dock.choice?.index).toBe(0);
  });

  it.each(["Escape", "blur", "pointerdown", "route"])(
    "cancels on %s without opening a chat",
    async (cancel) => {
      await using dock = await mountSwitcher();
      await dock.key("keydown", "Tab", { ctrlKey: true });
      if (cancel === "Escape") await dock.key("keydown", "Escape", { ctrlKey: true });
      else if (cancel === "route") await dock.route("different");
      else
        await act(() => {
          window.dispatchEvent(new Event(cancel));
        });
      await dock.key("keyup", "Control");
      expect(dock.choice).toBeNull();
      expect(dock.onSelect).not.toHaveBeenCalled();
    },
  );

  it("leaves Tab, Command+Tab, IME and dialogs alone", async () => {
    await using dock = await mountSwitcher();
    for (const options of [
      {},
      { metaKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, isComposing: true },
    ]) {
      expect((await dock.key("keydown", "Tab", options)).defaultPrevented).toBe(false);
    }
    const dialog = document.createElement("div");
    dialog.role = "dialog";
    dock.container.append(dialog);
    expect((await dock.key("keydown", "Tab", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(dock.choice).toBeNull();
    expect(dock.getEntries).not.toHaveBeenCalled();
  });

  it("starts at the first or last chat when the current route is outside the dock", async () => {
    await using dock = await mountSwitcher();
    await dock.route(null);
    await dock.key("keydown", "Tab", { ctrlKey: true });
    expect(dock.choice?.index).toBe(0);
    await dock.key("keydown", "Escape");
    await dock.key("keydown", "Tab", { ctrlKey: true, shiftKey: true });
    expect(dock.choice?.index).toBe(2);
  });

  it("does nothing for an empty dock", async () => {
    await using dock = await mountSwitcher();
    dock.entries = [];
    expect((await dock.key("keydown", "Tab", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(dock.choice).toBeNull();
  });

  it("continues the gesture handed off by the embedded browser", async () => {
    await using dock = await mountSwitcher();
    await dock.nativeAction("dock-switcher-next");
    expect(dock.choice?.index).toBe(1);
    await dock.key("keydown", "Tab", { ctrlKey: true });
    await dock.key("keyup", "Control");
    expect(dock.onSelect).toHaveBeenCalledExactlyOnceWith({ key: "c" });
  });

  it("handles a quick press and release before React renders the previews", async () => {
    await using dock = await mountSwitcher();
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    });
    expect(dock.onSelect).toHaveBeenCalledExactlyOnceWith({ key: "b" });
    expect(dock.choice).toBeNull();
  });
});

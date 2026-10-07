// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useConversationDockSwitcher } from "./useConversationDockSwitcher";

describe("dock chat switching", () => {
  let root: Root;
  let container: HTMLDivElement;
  let entries = [{ key: "a" }, { key: "b" }, { key: "c" }];
  let activeKey: string | null;
  let getEntries: ReturnType<typeof vi.fn<() => readonly { key: string }[]>>;
  let onSelect: ReturnType<typeof vi.fn<(entry: { key: string }) => void>>;
  let choice: ReturnType<typeof useConversationDockSwitcher<{ key: string }>>;
  let nativeAction: ((action: string) => void) | undefined;
  const unsubscribe = vi.fn();
  function Harness({ currentKey }: { currentKey: string | null }) {
    const currentChoice = useConversationDockSwitcher({
      getEntries,
      activeKey: currentKey,
      onSelect,
    });
    useLayoutEffect(() => {
      choice = currentChoice;
    }, [currentChoice]);
    return <textarea aria-label="Composer" />;
  }
  async function key(type: "keydown" | "keyup", key: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...options });
    await act(() => {
      container.querySelector("textarea")!.dispatchEvent(event);
    });
    return event;
  }
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        onMenuAction: (listener: (action: string) => void) => {
          nativeAction = listener;
          return unsubscribe;
        },
      },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    entries = [{ key: "a" }, { key: "b" }, { key: "c" }];
    activeKey = "a";
    getEntries = vi.fn(() => entries);
    onSelect = vi.fn();
    await act(() => root.render(<Harness currentKey={activeKey} />));
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    delete window.desktopBridge;
    vi.unstubAllGlobals();
  });

  it("previews without navigating, freezes order, then opens on Control release", async () => {
    expect(getEntries).not.toHaveBeenCalled();
    expect((await key("keydown", "Tab", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(choice?.entries[choice.index]?.key).toBe("b");
    expect(onSelect).not.toHaveBeenCalled();
    entries = [{ key: "c" }, { key: "new" }, { key: "a" }];
    await act(() => root.render(<Harness currentKey={activeKey} />));
    await key("keydown", "Tab", { ctrlKey: true });
    expect(choice?.entries.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
    expect(getEntries).toHaveBeenCalledTimes(1);
    await key("keyup", "Tab", { ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    await key("keyup", "Control");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ key: "c" });
    expect(choice).toBeNull();
  });

  it("wraps both ways and accepts deliberate key repeats", async () => {
    await key("keydown", "Tab", { ctrlKey: true, shiftKey: true });
    expect(choice?.index).toBe(2);
    await key("keydown", "Tab", { ctrlKey: true, repeat: true });
    expect(choice?.index).toBe(0);
  });

  it.each(["Escape", "blur", "pointerdown", "route"])(
    "cancels on %s without opening a chat",
    async (cancel) => {
      await key("keydown", "Tab", { ctrlKey: true });
      if (cancel === "Escape") await key("keydown", "Escape", { ctrlKey: true });
      else if (cancel === "route") {
        activeKey = "different";
        await act(() => root.render(<Harness currentKey={activeKey} />));
      } else
        await act(() => {
          window.dispatchEvent(new Event(cancel));
        });
      await key("keyup", "Control");
      expect(choice).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("leaves Tab, Command+Tab, IME and dialogs alone", async () => {
    for (const options of [
      {},
      { metaKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, isComposing: true },
    ]) {
      expect((await key("keydown", "Tab", options)).defaultPrevented).toBe(false);
    }
    const dialog = document.createElement("div");
    dialog.role = "dialog";
    container.append(dialog);
    expect((await key("keydown", "Tab", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(choice).toBeNull();
    expect(getEntries).not.toHaveBeenCalled();
  });

  it("starts at the first or last chat when the current route is outside the dock", async () => {
    activeKey = null;
    await act(() => root.render(<Harness currentKey={activeKey} />));
    await key("keydown", "Tab", { ctrlKey: true });
    expect(choice?.index).toBe(0);
    await key("keydown", "Escape");
    await key("keydown", "Tab", { ctrlKey: true, shiftKey: true });
    expect(choice?.index).toBe(2);
  });

  it("does nothing for an empty dock", async () => {
    entries = [];
    expect((await key("keydown", "Tab", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(choice).toBeNull();
  });

  it("continues the gesture handed off by the embedded browser", async () => {
    await act(() => nativeAction?.("dock-switcher-next"));
    expect(choice?.index).toBe(1);
    await key("keydown", "Tab", { ctrlKey: true });
    await key("keyup", "Control");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ key: "c" });
  });

  it("handles a quick press and release before React renders the previews", async () => {
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ key: "b" });
    expect(choice).toBeNull();
  });
});

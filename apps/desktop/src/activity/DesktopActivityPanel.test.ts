// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type DesktopActivitySnapshot } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => {
  class Events {
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    on(name: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    once(name: string, listener: (...args: unknown[]) => void) {
      this.on(name, listener);
    }
    emit(name: string, ...args: unknown[]) {
      this.listeners.get(name)?.forEach((listener) => listener(...args));
    }
  }
  class Window extends Events {
    destroyed = false;
    resolveShown = () => {};
    shown = new Promise<void>((resolve) => {
      this.resolveShown = resolve;
    });
    webContents = Object.assign(new Events(), {
      setWindowOpenHandler: vi.fn(),
      isLoadingMainFrame: () => false,
      executeJavaScript: vi.fn(async () => {}),
    });
    loadURL = vi.fn(async () => {});
    setBounds = vi.fn();
    show = vi.fn(() => this.resolveShown());
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit("closed");
    });
    constructor() {
      super();
      windows.push(this);
    }
  }
  class Tray extends Events {
    setToolTip = vi.fn();
    setTitle = vi.fn();
    destroy = vi.fn();
    getBounds = () => ({ x: 1200, y: 0, width: 24, height: 24 });
    constructor() {
      super();
      trays.push(this);
    }
  }
  const windows: Window[] = [];
  const trays: Tray[] = [];
  const setMenu = vi.fn();
  return { Window, Tray, windows, trays, setMenu };
});

vi.mock("electron", () => ({
  BrowserWindow: native.Window,
  Tray: native.Tray,
  app: { dock: { getMenu: () => null, setMenu: native.setMenu } },
  Menu: { buildFromTemplate: (items: unknown) => items },
  nativeImage: { createFromBuffer: () => ({ setTemplateImage: vi.fn() }) },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 876 } }) },
}));

import {
  activityContent,
  activityPanelBounds,
  DesktopActivityPanel,
} from "./DesktopActivityPanel.ts";

const thread = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
  title: "Review changes",
  project: "Project",
  environment: "Remote Mac",
  status: "approval" as const,
};
const snapshot: DesktopActivitySnapshot = {
  threads: [thread],
  attentionCount: 1,
  workingCount: 0,
  unavailableCount: 0,
};
let panel: DesktopActivityPanel | undefined;
beforeEach(() => {
  panel = undefined;
  native.windows.length = 0;
  native.trays.length = 0;
  vi.clearAllMocks();
});
afterEach(() => panel?.dispose());

describe("desktop activity panel", () => {
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

  it("stays inside smaller displays and displays to the left of the main screen", () => {
    const workArea = { x: -1280, y: -900, width: 1280, height: 700 };
    for (const x of [-1280, -24]) {
      const bounds = activityPanelBounds({ x, y: -924, width: 24, height: 24 }, workArea, snapshot);
      expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
      expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
      expect(bounds.height).toBeLessThan(300);
    }
  });

  it("does no window work while hidden and skips unchanged snapshots", () => {
    panel = new DesktopActivityPanel(vi.fn());
    panel.update(snapshot);
    const calls = native.setMenu.mock.calls.length;
    panel.update({ ...snapshot });
    expect(native.setMenu).toHaveBeenCalledTimes(calls);
    expect(native.windows).toHaveLength(0);
    expect(native.trays[0]!.setTitle).toHaveBeenLastCalledWith("1");
    panel.update(null);
    expect(native.trays[0]!.setTitle).toHaveBeenLastCalledWith("");
  });

  it("opens the selected chat, blocks unrelated navigation, and disposes the window", async () => {
    const open = vi.fn();
    panel = new DesktopActivityPanel(open);
    panel.update(snapshot);
    native.trays[0]!.emit("click");
    const window = native.windows[0]!;
    await window.shown;
    const preventDefault = vi.fn();
    window.webContents.emit("will-navigate", { preventDefault }, "https://example.com");
    expect(open).not.toHaveBeenCalled();
    window.webContents.emit(
      "will-navigate",
      { preventDefault },
      "t3-activity://thread?environmentId=other&threadId=thread",
    );
    expect(open).not.toHaveBeenCalled();
    window.webContents.emit(
      "will-navigate",
      { preventDefault },
      "t3-activity://thread?environmentId=remote&threadId=thread",
    );
    expect(open).toHaveBeenCalledWith(thread);
    expect(window.destroyed).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it.each(["blur", "Escape"])("dismisses with %s and can reopen", async (reason) => {
    panel = new DesktopActivityPanel(vi.fn());
    native.trays[0]!.emit("click");
    const window = native.windows[0]!;
    await window.shown;
    if (reason === "blur") window.emit("blur");
    else
      window.webContents.emit("before-input-event", { preventDefault: vi.fn() }, { key: "Escape" });
    expect(window.destroyed).toBe(true);
    native.trays[0]!.emit("click");
    await native.windows[1]!.shown;
    expect(native.windows[1]!.destroyed).toBe(false);
  });
});

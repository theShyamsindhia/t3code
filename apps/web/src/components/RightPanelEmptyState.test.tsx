// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RightPanelEmptyState } from "./RightPanelTabs";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderLauncher(
  overrides: Partial<ComponentProps<typeof RightPanelEmptyState>> = {},
) {
  const actions = {
    onAddBrowser: vi.fn(),
    onAddBrowserInProfile: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddPullRequests: vi.fn(),
    onAddDevice: vi.fn(),
  };
  await act(async () =>
    root.render(
      <RightPanelEmptyState
        {...actions}
        sculpted
        browserProfiles={[]}
        browserAvailable
        terminalAvailable
        diffAvailable
        filesAvailable
        pullRequestAvailable
        pullRequestsAvailable
        deviceAvailable
        {...overrides}
      />,
    ),
  );
  return actions;
}

function moreButton() {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "More surfaces",
  );
}

async function key(target: Element, value: string) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ),
  );
}

describe("sculpted surface launcher", () => {
  it("reveals and hides the secondary tools while keeping their shortcuts available", async () => {
    const actions = await renderLauncher();
    expect(container.textContent).not.toContain("Linked pull requests");
    const launcher = container.querySelector('[aria-label="Open a surface"]')!;
    await key(launcher, "l");
    expect(actions.onAddPullRequests).toHaveBeenCalledOnce();

    await act(async () => moreButton()!.click());
    expect(container.textContent).toContain("Linked pull requests");
    await act(async () => moreButton()!.click());
    expect(container.textContent).not.toContain("Linked pull requests");
    await key(launcher, "m");
    expect(actions.onAddDevice).toHaveBeenCalledOnce();
  });

  it("keeps arrow navigation on visible, available tools and resets it when the list closes", async () => {
    const actions = await renderLauncher({ browserAvailable: false });
    const launcher = container.querySelector('[aria-label="Open a surface"]')!;
    await key(launcher, "ArrowUp");
    await key(launcher, "Enter");
    expect(actions.onAddDiff).toHaveBeenCalledOnce();
    expect(actions.onAddDevice).not.toHaveBeenCalled();

    await act(async () => moreButton()!.click());
    await key(launcher, "ArrowUp");
    await key(launcher, "Enter");
    expect(actions.onAddDevice).toHaveBeenCalledOnce();

    await act(async () => moreButton()!.click());
    await key(launcher, "ArrowDown");
    await key(launcher, "Enter");
    expect(actions.onAddTerminal).toHaveBeenCalledOnce();
    await key(launcher, "b");
    expect(actions.onAddBrowser).not.toHaveBeenCalled();
  });

  it("does not intercept typing or shortcuts while a menu is open", async () => {
    const actions = await renderLauncher();
    const input = document.createElement("textarea");
    container.append(input);
    await key(input, "t");
    expect(actions.onAddTerminal).not.toHaveBeenCalled();

    const menu = document.createElement("div");
    menu.dataset.slot = "menu-popup";
    container.append(menu);
    await key(container, "m");
    expect(actions.onAddDevice).not.toHaveBeenCalled();
    menu.remove();
    await key(container, "m");
    expect(actions.onAddDevice).toHaveBeenCalledOnce();
  });

  it("keeps every tool visible when Sculpted Material is turned off", async () => {
    await renderLauncher({ sculpted: false });
    expect(moreButton()).toBeUndefined();
    expect(container.textContent).toContain("Linked pull requests");
    expect(container.textContent).toContain("Device");
  });
});

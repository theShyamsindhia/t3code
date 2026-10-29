import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { RightPanelEmptyState } from "./RightPanelTabs";

async function renderLauncher(
  overrides: Partial<ComponentProps<typeof RightPanelEmptyState>> = {},
) {
  const actions = {
    onAddBrowser: vi.fn(),
    onAddBrowserInProfile: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddCanvas: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddPullRequests: vi.fn(),
    onAddDevice: vi.fn(),
  };
  const screen = await render(
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
      canvasAvailable
      {...overrides}
    />,
  );
  return { actions, screen, container: screen.container };
}

function moreButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "More surfaces",
  );
}

async function key(target: Element, value: string) {
  await act(() =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ),
  );
}

describe("sculpted surface launcher", () => {
  it("reveals and hides the secondary tools while keeping their shortcuts available", async () => {
    const { actions, screen, container } = await renderLauncher();
    await using _screen = screen;
    expect(container.textContent).not.toContain("Linked pull requests");
    const launcher = container.querySelector('[aria-label="Open a surface"]')!;
    await key(launcher, "l");
    expect(actions.onAddPullRequests).toHaveBeenCalledOnce();

    await act(() => moreButton(container)!.click());
    expect(container.textContent).toContain("Linked pull requests");
    await act(() => moreButton(container)!.click());
    expect(container.textContent).not.toContain("Linked pull requests");
    await key(launcher, "m");
    expect(actions.onAddDevice).toHaveBeenCalledOnce();
  });

  it("keeps arrow navigation on visible, available tools and resets it when the list closes", async () => {
    const { actions, screen, container } = await renderLauncher({ browserAvailable: false });
    await using _screen = screen;
    const launcher = container.querySelector('[aria-label="Open a surface"]')!;
    await key(launcher, "ArrowUp");
    await key(launcher, "Enter");
    expect(actions.onAddCanvas).toHaveBeenCalledOnce();
    expect(actions.onAddDiff).not.toHaveBeenCalled();
    expect(actions.onAddDevice).not.toHaveBeenCalled();

    await act(() => moreButton(container)!.click());
    await key(launcher, "ArrowUp");
    await key(launcher, "Enter");
    expect(actions.onAddDevice).toHaveBeenCalledOnce();

    await act(() => moreButton(container)!.click());
    await key(launcher, "ArrowDown");
    await key(launcher, "Enter");
    expect(actions.onAddTerminal).toHaveBeenCalledOnce();
    await key(launcher, "b");
    expect(actions.onAddBrowser).not.toHaveBeenCalled();
  });

  it("does not intercept typing or shortcuts while a menu is open", async () => {
    const { actions, screen, container } = await renderLauncher();
    await using _screen = screen;
    const input = document.createElement("textarea");
    container.append(input);
    await key(input, "t");
    expect(actions.onAddTerminal).not.toHaveBeenCalled();

    const menu = document.createElement("div");
    menu.dataset.slot = "menu-popup";
    menu.dataset.open = "";
    container.append(menu);
    await key(container, "m");
    expect(actions.onAddDevice).not.toHaveBeenCalled();
    menu.remove();
    await key(container, "m");
    expect(actions.onAddDevice).toHaveBeenCalledOnce();
  });

  it("keeps every tool visible when Sculpted Material is turned off", async () => {
    const { screen, container } = await renderLauncher({ sculpted: false });
    await using _screen = screen;
    expect(moreButton(container)).toBeUndefined();
    expect(container.textContent).toContain("Linked pull requests");
    expect(container.textContent).toContain("Device");
  });
});

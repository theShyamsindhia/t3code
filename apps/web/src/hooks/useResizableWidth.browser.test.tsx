import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";
import { useResizableWidth } from "./useResizableWidth";

function Panel({ rowWidth }: { rowWidth: number | undefined }) {
  const { width, handlers } = useResizableWidth({
    storageKey: "test-panel-width",
    defaultWidth: 400,
    minWidth: 200,
    maxWidth: 800,
    edge: "left",
    rowWidth,
  });
  return (
    <aside>
      <output>{width}</output>
      <div data-testid="handle" {...handlers} />
    </aside>
  );
}

const shownWidth = (screen: Screen) =>
  Number(screen.container.querySelector("output")!.textContent);

// Synthetic pointers have no active pointer for the browser to capture.
async function dragHandle(screen: Screen, fromX: number, toX: number) {
  const handle = screen.container.querySelector<HTMLElement>("[data-testid=handle]")!;
  let captured = false;
  handle.setPointerCapture = () => {
    captured = true;
  };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => {
    captured = false;
  };
  await act(() => {
    for (const [type, clientX] of [
      ["pointerdown", fromX],
      ["pointerup", toX],
    ] as const) {
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX,
        }),
      );
    }
  });
}

function setup() {
  localStorage.clear();
}

describe("panel width row tracking", () => {
  it("absorbs row changes so the sibling column keeps its width", async () => {
    setup();
    using setItem = vi.spyOn(Storage.prototype, "setItem");
    await using screen = await render(<Panel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(400);
    // App sidebar collapses: the row widens and the panel takes all of it.
    await screen.rerender(<Panel rowWidth={1256} />);
    expect(shownWidth(screen)).toBe(656);
    await screen.rerender(<Panel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(400);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("restores the same split after a row change hits the panel bounds", async () => {
    setup();
    await using screen = await render(<Panel rowWidth={1000} />);
    await screen.rerender(<Panel rowWidth={700} />);
    expect(shownWidth(screen)).toBe(200);
    await screen.rerender(<Panel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(400);
  });

  it("starts from a fresh baseline after tracking stops", async () => {
    setup();
    await using screen = await render(<Panel rowWidth={1000} />);
    await screen.rerender(<Panel rowWidth={undefined} />);
    await screen.rerender(<Panel rowWidth={1256} />);
    expect(shownWidth(screen)).toBe(400);
  });

  it("drags from the shifted width and saves what the user released", async () => {
    setup();
    await using screen = await render(<Panel rowWidth={1000} />);
    await screen.rerender(<Panel rowWidth={1100} />);
    using setItem = vi.spyOn(Storage.prototype, "setItem");
    await dragHandle(screen, 100, 50);
    expect(shownWidth(screen)).toBe(550);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "550");
    await screen.rerender(<Panel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(450);
  });
});

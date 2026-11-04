import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

function RowPanel({ rowWidth }: { rowWidth: number | undefined }) {
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
    await using screen = await render(<RowPanel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(400);
    // App sidebar collapses: the row widens and the panel takes all of it.
    await screen.rerender(<RowPanel rowWidth={1256} />);
    expect(shownWidth(screen)).toBe(656);
    await screen.rerender(<RowPanel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(400);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("restores the same split after a row change hits the panel bounds", async () => {
    setup();
    await using screen = await render(<RowPanel rowWidth={1000} />);
    await screen.rerender(<RowPanel rowWidth={700} />);
    expect(shownWidth(screen)).toBe(200);
    await screen.rerender(<RowPanel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(400);
  });

  it("starts from a fresh baseline after tracking stops", async () => {
    setup();
    await using screen = await render(<RowPanel rowWidth={1000} />);
    await screen.rerender(<RowPanel rowWidth={undefined} />);
    await screen.rerender(<RowPanel rowWidth={1256} />);
    expect(shownWidth(screen)).toBe(400);
  });

  it("drags from the shifted width and saves what the user released", async () => {
    setup();
    await using screen = await render(<RowPanel rowWidth={1000} />);
    await screen.rerender(<RowPanel rowWidth={1100} />);
    using setItem = vi.spyOn(Storage.prototype, "setItem");
    await dragHandle(screen, 100, 50);
    expect(shownWidth(screen)).toBe(550);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "550");
    await screen.rerender(<RowPanel rowWidth={1000} />);
    expect(shownWidth(screen)).toBe(450);
  });
});

const STORAGE_KEY = "test:responsive-panel-width";

function DefaultPanel({ defaultWidth }: { defaultWidth: number }) {
  const { width, setWidth, handlers } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth,
    minWidth: 160,
    maxWidth: 560,
    edge: "left",
  });
  return (
    <>
      <button onClick={() => setWidth(350)}>{width}</button>
      <div role="separator" style={{ width: 8, height: 40 }} {...handlers} />
    </>
  );
}

describe("useResizableWidth", () => {
  it("follows a responsive default until the user saves a width", async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    try {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<DefaultPanel defaultWidth={320} />, { router: false });
      expect(screen.container.textContent).toBe("320");
      await screen.rerender(<DefaultPanel defaultWidth={200} />);
      expect(screen.container.textContent).toBe("200");

      await act(() => screen.container.querySelector("button")!.click());
      await screen.rerender(<DefaultPanel defaultWidth={180} />);
      expect(screen.container.textContent).toBe("350");

      await screen.unmount();
      await using restored = await render(<DefaultPanel defaultWidth={200} />, { router: false });
      expect(restored.container.textContent).toBe("350");
    } finally {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    }
  });

  it("keeps the default responsive after a stationary click and persists an actual drag", async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    try {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<DefaultPanel defaultWidth={240} />, { router: false });
      await screen.getByRole("separator").click();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      await screen.rerender(<DefaultPanel defaultWidth={256} />);
      expect(screen.container.textContent).toBe("256");

      const handle = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
      // Synthetic drag events have no active browser pointer to capture.
      using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
      const pointer = { bubbles: true, pointerId: 1, button: 0 };
      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 500 }));
      });
      await screen.rerender(<DefaultPanel defaultWidth={280} />);
      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 500 }));
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(screen.container.style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY)).toBe("280px");

      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 500 }));
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 450 }));
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBe("330");
      await screen.rerender(<DefaultPanel defaultWidth={200} />);
      expect(screen.container.textContent).toBe("330");
    } finally {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    }
  });
});

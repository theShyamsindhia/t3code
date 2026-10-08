// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { startLiveEdit } from "./LiveEdit.ts";
import { createLiveEditHistory, editableTextNode } from "./LiveEditHistory.ts";
import type { PickedElementPayload } from "@t3tools/contracts";

beforeEach(() => {
  document.body.innerHTML =
    '<button id="save" style="color: red !important">Save</button><div id="panel"><span>Nested text</span></div>';
  vi.stubGlobal("CSS", {
    supports: (property: string, value: string) => {
      const style = document.createElement("div").style;
      style.setProperty(property, value);
      return style.getPropertyValue(property) !== "";
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
const save = () => document.querySelector<HTMLButtonElement>("#save")!;
const panel = () => document.querySelector<HTMLDivElement>("#panel")!;

describe("live edit history", () => {
  it("restores longhand declarations after editing a shorthand", () => {
    save().style.setProperty("padding-left", "13px", "important");
    save().style.setProperty("border-top", "2px dashed red");
    const history = createLiveEditHistory();
    history.setStyles(save(), { padding: "20px", border: "1px solid blue" });
    history.reset();
    expect(save().style.paddingLeft).toBe("13px");
    expect(save().style.getPropertyPriority("padding-left")).toBe("important");
    expect(save().style.paddingRight).toBe("");
    expect(save().style.borderTop).toBe("2px dashed red");
  });
  it("restores original inline priorities and leaves unrelated styles alone", () => {
    const history = createLiveEditHistory();
    history.setStyles(save(), { color: "blue", width: "120px" });
    save().style.height = "50px";
    history.undo();
    expect(save().style.color).toBe("red");
    expect(save().style.getPropertyPriority("color")).toBe("important");
    expect(save().style.width).toBe("");
    expect(save().style.height).toBe("50px");
    history.redo();
    expect(save().style.width).toBe("120px");
    history.reset();
    expect(save().style.color).toBe("red");
    expect(history.canRedo).toBe(false);
  });
  it("coalesces a gesture, keeps edits across elements, and clears redo on a new edit", () => {
    const history = createLiveEditHistory();
    history.setStyles(save(), { width: "100px" });
    history.setStyles(save(), { width: "110px" });
    history.setStyles(panel(), { width: "200px" });
    history.undo();
    expect(save().style.width).toBe("110px");
    expect(panel().style.width).toBe("");
    history.undo();
    expect(save().style.width).toBe("");
    history.setStyles(save(), { padding: "10px" });
    expect(history.canRedo).toBe(false);
  });
  it("undoes an entire resize even when only one dimension changes partway through", () => {
    const history = createLiveEditHistory();
    history.setStyles(save(), { width: "100px", height: "50px" });
    history.setStyles(save(), { width: "100px", height: "60px" });
    history.setStyles(save(), { width: "120px", height: "60px" });
    history.undo();
    expect(save().style.width).toBe("");
    expect(save().style.height).toBe("");
    expect(history.canUndo).toBe(false);
  });
  it("moves multiple elements as one undoable gesture while preserving their transforms", () => {
    save().style.transform = "rotate(10deg)";
    const history = createLiveEditHistory();
    for (const offset of [10, 20, 30])
      history.setStyleBatch([
        { element: save(), values: { transform: `translate(${offset}px, 5px) rotate(10deg)` } },
        { element: panel(), values: { transform: `translate(${offset}px, 5px)` } },
      ]);
    expect(history.changes()).toHaveLength(2);
    history.undo();
    expect(save().style.transform).toBe("rotate(10deg)");
    expect(panel().style.transform).toBe("");
    expect(history.canUndo).toBe(false);
    history.redo();
    expect(panel().style.transform).toBe("translate(30px, 5px)");
    history.reset();
    expect(save().style.transform).toBe("rotate(10deg)");
  });
  it("reports the first baseline and latest value without changing undo records", () => {
    const history = createLiveEditHistory();
    history.setStyles(save(), { width: "100px" });
    history.checkpoint();
    history.setStyles(save(), { width: "200px" });
    expect(history.changes()).toHaveLength(1);
    history.undo();
    expect(save().style.width).toBe("100px");
    expect(history.changes()[0]?.after).toEqual({ value: "100px", priority: "important" });
    expect(history.setStyles(save(), { width: "nonsense" })).toBe(false);
  });
  it("edits text without replacing nodes or removing child components", () => {
    const history = createLiveEditHistory();
    const node = save().firstChild;
    history.setText(save(), "Keep");
    expect(save().firstChild).toBe(node);
    expect(save().textContent).toBe("Keep");
    expect(history.setText(panel(), "Broken")).toBe(false);
    expect(panel().firstElementChild?.tagName).toBe("SPAN");
    history.undo();
    expect(save().textContent).toBe("Save");
    expect(editableTextNode(document.createElement("textarea"))).toBeNull();
  });
  it("does not report detached nodes or overwrite replacement text on reset", () => {
    const history = createLiveEditHistory();
    history.setText(save(), "Keep");
    save().textContent = "Re-rendered";
    expect(history.changes()).toHaveLength(0);
    history.reset();
    expect(save().textContent).toBe("Re-rendered");
    history.setStyles(save(), { width: "200px" });
    save().remove();
    expect(history.changes()).toHaveLength(0);
  });
});

describe("live edit surface", () => {
  let session: ReturnType<typeof startLiveEdit>;
  afterEach(() => session?.dispose());
  function setup(capture?: () => Promise<PickedElementPayload>) {
    const host = document.createElement("div");
    document.documentElement.append(host);
    const attach = vi.fn();
    const cancel = vi.fn(() => session.dispose());
    session = startLiveEdit({
      host,
      attach,
      cancel,
      captureElement:
        capture ??
        (async (element) => ({
          pageUrl: "https://example.com",
          pageTitle: "Example",
          selector: `#${element.id}`,
          tagName: element.tagName.toLowerCase(),
          htmlPreview: element.outerHTML,
          componentName: null,
          source: null,
          stack: [],
          styles: "",
          pickedAt: "2026-10-08T00:00:00.000Z",
        })),
    });
    const root = host.shadowRoot!;
    const click = (label: string) =>
      [...root.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
    const pointer = (element: EventTarget, type: string, options: MouseEventInit = {}) =>
      element.dispatchEvent(
        new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, ...options }),
      );
    const select = (element: Element, shiftKey = false) => {
      pointer(element, "pointerdown", { shiftKey });
      pointer(element, "pointerup");
    };
    const edit = (label: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    return { host, root, attach, cancel, click, select, edit, pointer };
  }
  it("blocks page actions during selection and permits them in Play", () => {
    const ui = setup();
    const action = vi.fn();
    save().addEventListener("click", action);
    ui.select(save());
    save().click();
    expect(action).not.toHaveBeenCalled();
    ui.edit("Radius", "16px");
    ui.click("Play");
    save().click();
    expect(action).toHaveBeenCalledOnce();
    expect(save().style.borderRadius).toBe("16px");
    ui.click("Select");
    ui.click("Close");
    expect(save().style.borderRadius).toBe("");
    save().click();
    expect(action).toHaveBeenCalledTimes(2);
  });
  it("shift-selects, drags a group, and undoes the complete movement", () => {
    const ui = setup();
    ui.select(save());
    ui.select(panel(), true);
    expect(ui.root.querySelector(".name")?.textContent).toBe("2 elements selected");
    expect(ui.root.querySelectorAll(".resize")).toHaveLength(8);
    ui.pointer(save(), "pointerdown", { clientX: 10, clientY: 20 });
    ui.pointer(window, "pointermove", { clientX: 40, clientY: 50 });
    ui.pointer(window, "pointermove", { clientX: 50, clientY: 60 });
    ui.pointer(window, "pointerup");
    expect(save().style.transform).toBe("translate(40px, 40px)");
    expect(panel().style.transform).toBe("translate(40px, 40px)");
    ui.click("Undo");
    expect(save().style.transform).toBe("");
    expect(panel().style.transform).toBe("");
    ui.click("Redo");
    expect(panel().style.transform).toBe("translate(40px, 40px)");
    ui.select(save(), true);
    expect(ui.root.querySelector(".name")?.textContent).toBe("div#panel");
  });
  it("avoids double movement of nested selections and leaves a click unchanged", () => {
    const ui = setup();
    ui.select(panel());
    ui.select(panel().firstElementChild!, true);
    expect(ui.root.querySelector(".name")?.textContent).toBe("span");
    ui.select(panel(), true);
    expect(ui.root.querySelector(".name")?.textContent).toBe("div#panel");
    expect(ui.root.querySelectorAll(".resize")).toHaveLength(4);
    expect(panel().style.transform).toBe("");
    expect(
      [...ui.root.querySelectorAll("button")].find((button) => button.textContent === "Undo")
        ?.disabled,
    ).toBe(true);
  });
  it.each([
    ["nw", "80px", "40px", "translate(20px, 10px)"],
    ["ne", "120px", "40px", "translate(0px, 10px)"],
    ["sw", "80px", "60px", "translate(20px, 0px)"],
    ["se", "120px", "60px", ""],
  ])("resizes from %s and restores the original box", (corner, width, height, transform) => {
    save().style.width = "100px";
    save().style.height = "50px";
    const ui = setup();
    ui.select(save());
    const handle = ui.root.querySelector(`[aria-label="Resize ${corner}"]`)!;
    ui.pointer(handle, "pointerdown", { clientX: 50, clientY: 50 });
    ui.pointer(window, "pointermove", { clientX: 70, clientY: 60 });
    ui.pointer(window, "pointerup");
    expect(save().style.width).toBe(width);
    expect(save().style.height).toBe(height);
    expect(save().style.transform).toBe(transform);
    ui.click("Undo");
    expect(save().style.width).toBe("100px");
    expect(save().style.height).toBe("50px");
    expect(save().style.transform).toBe("");
  });
  it("drags the inset dot to round corners and undo restores individual radii", () => {
    save().style.borderTopLeftRadius = "12px";
    save().style.borderBottomRightRadius = "8px";
    vi.spyOn(save(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
    const ui = setup();
    ui.select(save());
    const dot = ui.root.querySelector('[aria-label="Adjust corner roundness"]')!;
    ui.pointer(dot, "pointerdown");
    ui.pointer(window, "pointermove", { clientX: 20, clientY: 20 });
    ui.pointer(window, "pointerup");
    expect(save().style.borderRadius).toBe("32px");
    ui.click("Undo");
    expect(save().style.borderTopLeftRadius).toBe("12px");
    expect(save().style.borderBottomRightRadius).toBe("8px");
    expect(save().style.borderTopRightRadius).toBe("");
  });
  it("scrubs a numeric value for the selection and coalesces the dial gesture", () => {
    save().style.padding = panel().style.padding = "10px";
    const ui = setup();
    ui.select(save());
    ui.select(panel(), true);
    const dial = ui.root.querySelector('[aria-label="Adjust padding"]')!;
    ui.pointer(dial, "pointerdown", { clientX: 20 });
    expect(ui.root.activeElement).toBe(dial);
    ui.pointer(window, "pointermove", { clientX: 30 });
    ui.pointer(window, "pointermove", { clientX: 40 });
    ui.pointer(window, "pointerup");
    expect(save().style.padding).toBe("30px");
    expect(panel().style.padding).toBe("30px");
    ui.click("Undo");
    expect(save().style.padding).toBe("10px");
    expect(panel().style.padding).toBe("10px");
  });
  it("supports dial keyboard adjustments, units, bounds, and fine steps", () => {
    save().style.opacity = "0.95";
    save().style.padding = "1rem";
    const ui = setup();
    ui.select(save());
    const opacity = ui.root.querySelector('[aria-label="Adjust opacity"]')!;
    ui.pointer(opacity, "pointerdown");
    ui.pointer(window, "pointermove", { clientX: 20 });
    ui.pointer(window, "pointerup");
    expect(save().style.opacity).toBe("1");
    const padding = ui.root.querySelector('[aria-label="Adjust padding"]')!;
    padding.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }),
    );
    expect(save().style.padding).toBe("1.1rem");
    ui.click("Undo");
    expect(save().style.padding).toBe("1rem");
    ui.pointer(padding, "pointerdown");
    ui.pointer(window, "pointermove", { clientX: 10, shiftKey: true });
    ui.pointer(window, "pointerup");
    expect(save().style.padding).toBe("1.1rem");
  });
  it("attaches all edited elements with original values after changing selection", async () => {
    const ui = setup();
    ui.select(save());
    ui.edit("Text color", "blue");
    ui.select(panel());
    ui.edit("Gap", "12px");
    ui.click("Attach edits to chat");
    await vi.waitFor(() => expect(ui.attach).toHaveBeenCalledOnce());
    const annotation = ui.attach.mock.calls[0]![0];
    expect(annotation.elements).toHaveLength(2);
    expect(annotation.styleChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: "#save",
          property: "color",
          previousValue: "rgb(255, 0, 0)",
          value: "blue",
        }),
        expect.objectContaining({ selector: "#panel", property: "gap", value: "12px" }),
      ]),
    );
    expect(ui.host.style.visibility).toBe("hidden");
    session.dispose();
    expect(save().style.color).toBe("red");
    expect(panel().style.gap).toBe("");
  });
  it("does not attach a late capture after cancellation", async () => {
    let resolveCapture!: (value: PickedElementPayload) => void;
    const ui = setup(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    ui.select(save());
    ui.edit("Radius", "10px");
    ui.click("Attach edits to chat");
    ui.click("Close");
    resolveCapture({
      pageUrl: "https://example.com",
      pageTitle: null,
      selector: "#save",
      tagName: "button",
      htmlPreview: "",
      componentName: null,
      source: null,
      stack: [],
      styles: "",
      pickedAt: "now",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.attach).not.toHaveBeenCalled();
    expect(save().style.borderRadius).toBe("");
  });
});

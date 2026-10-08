// @effect-diagnostics globalDate:off cryptoRandomUUID:off - This page preload runs outside the Effect runtime.
import type { PickedElementPayload, PreviewAnnotationPayload } from "@t3tools/contracts";
import { createLiveEditHistory, editableTextNode } from "./LiveEditHistory.ts";

const styles = `
:host { color:var(--t3-foreground,#eee); font:13px var(--t3-font-sans,system-ui); }
* { box-sizing:border-box; }
button,input { font:inherit; color:inherit; }
button { cursor:pointer; border:1px solid transparent; border-radius:999px; padding:7px 11px; background:transparent; }
button:hover,button[aria-pressed=true] { background:var(--t3-accent,#333); }
button:disabled { opacity:.4; cursor:default; }
button:focus-visible,input:focus-visible { outline:1px solid var(--t3-ring,currentColor); outline-offset:2px; }
.bar,.inspector { pointer-events:auto; position:fixed; background:var(--t3-popover,#222); border:1px solid var(--t3-border,#444); border-radius:20px; }
.bar { top:12px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:4px; padding:6px; width:max-content; max-width:calc(100vw - 16px); flex-wrap:wrap; justify-content:center; }
.bar strong { padding:0 10px; font-weight:550; }
.inspector { top:76px; right:12px; width:min(284px,calc(100vw - 24px)); max-height:calc(100vh - 88px); display:flex; flex-direction:column; overflow:hidden; padding:16px; }
.heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:550; }
.hint { color:var(--t3-muted-foreground,#aaa); font-size:12px; line-height:1.5; margin:8px 0 12px; }
.fields { display:grid; gap:9px; min-height:0; overflow:auto; padding:2px; }
label,.field { display:grid; grid-template-columns:90px minmax(0,1fr); gap:8px; align-items:center; font-size:12px; }
.field > label { display:block; }
.value { display:flex; align-items:center; gap:7px; min-width:0; }
.dial { position:relative; width:22px; height:22px; flex-shrink:0; border:1px solid var(--t3-border,#444); padding:0; cursor:ew-resize; touch-action:none; }
.dial::after { content:""; position:absolute; width:2px; height:6px; top:3px; left:9px; background:currentColor; border-radius:2px; transform-origin:1px 7px; transform:rotate(var(--turn,0deg)); }
.radius { position:absolute; left:14px; top:14px; width:10px; height:10px; padding:0; border:1px solid var(--t3-ring,currentColor); border-radius:50%; background:var(--t3-popover,#222); box-shadow:0 0 0 2px var(--t3-popover,#222); pointer-events:auto; touch-action:none; cursor:ew-resize; }
input { min-width:0; width:100%; height:30px; padding:4px 8px; background:var(--t3-background,#111); border:1px solid var(--t3-input,#444); border-radius:8px; }
input:disabled { opacity:.45; }
input[aria-invalid=true] { outline:1px solid currentColor; }
.outline { position:fixed; pointer-events:none; border:1px solid var(--t3-ring,currentColor); border-radius:3px; }
.resize { position:absolute; width:10px; height:10px; padding:0; border-radius:50%; border:1px solid var(--t3-ring,currentColor); background:var(--t3-popover,#222); pointer-events:auto; cursor:nwse-resize; touch-action:none; }
.move { position:absolute; top:-30px; left:0; pointer-events:auto; cursor:move; touch-action:none; white-space:nowrap; background:var(--t3-popover,#222); border:1px solid var(--t3-ring,currentColor); font-size:11px; padding:4px 8px; }
.footer { border-top:1px solid var(--t3-border,#444); margin-top:12px; padding-top:12px; flex-shrink:0; }
.attach { width:100%; background:var(--t3-accent,#333); }
[hidden] { display:none!important; }
`;

function selectorFor(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const siblings: Element[] = current.parentElement
      ? Array.from(current.parentElement.children)
      : [current];
    parts.unshift(`${current.localName}:nth-child(${siblings.indexOf(current) + 1})`);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

/** Lives in the inspected page; IPC and screenshot capture stay in PickPreload. */
export function startLiveEdit(options: {
  host: HTMLDivElement;
  captureElement: (element: Element) => Promise<PickedElementPayload>;
  attach: (annotation: PreviewAnnotationPayload) => void;
  cancel: () => void;
}) {
  const { host } = options;
  const history = createLiveEditHistory();
  const root = host.attachShadow({ mode: "open" });
  const sheet = document.createElement("style");
  sheet.textContent = styles;
  root.append(sheet);
  let selected: Array<HTMLElement | SVGElement> = [];
  const outlines = new Map<HTMLElement | SVGElement, HTMLDivElement>();
  let playing = false;
  let disposed = false;
  let capturing = false;
  let frame: number | null = null;

  const make = <T extends keyof HTMLElementTagNameMap>(tag: T, className = "") => {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  };
  const button = (label: string, action: () => void) => {
    const element = make("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
  };
  const bar = make("div", "bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Live edit");
  const title = make("strong");
  title.textContent = "Live edit";
  const mode = button("Play", () => {
    endDrag();
    playing = !playing;
    history.checkpoint();
    mode.textContent = playing ? "Select" : "Play";
    mode.setAttribute("aria-pressed", String(playing));
    inspector.hidden = playing;
    hover.hidden = true;
    repaint();
  });
  mode.title = "Switch between selecting elements and using the page";
  const undo = button("Undo", () => {
    history.undo();
    refresh();
  });
  const redo = button("Redo", () => {
    history.redo();
    refresh();
  });
  const reset = button("Reset", () => {
    history.reset();
    refresh();
  });
  const close = button("Close", options.cancel);
  close.title = "Exit and restore the page (Esc)";
  bar.append(title, mode, undo, redo, reset, close);

  const inspector = make("section", "inspector");
  inspector.setAttribute("aria-label", "Element appearance");
  const heading = make("div", "heading");
  const name = make("div", "name");
  const parent = button("Parent ↑", () => {
    const element = selected[0]?.parentElement;
    if (element && element !== document.documentElement) select(element);
  });
  heading.append(name, parent);
  const hint = make("p", "hint");
  hint.textContent =
    "Drag to move. Shift-click to select together. Outer dots resize; the inset dot rounds corners. Drag a dial to adjust a value.";
  const fields = make("div", "fields");
  const controls = new Map<string, HTMLInputElement>();
  const dials = new Map<string, HTMLButtonElement>();
  const text = make("input");
  text.type = "text";
  text.maxLength = 2000;
  const textLabel = make("label");
  textLabel.append("Text", text);
  text.title = "Available for plain text elements; select a child to edit nested text";
  text.addEventListener("input", () => {
    if (selected.length === 1 && selected[0] instanceof HTMLElement)
      history.setText(selected[0], text.value);
    refresh(false);
  });
  text.addEventListener("blur", () => history.checkpoint());
  fields.append(textLabel);

  for (const [label, property] of [
    ["Width", "width"],
    ["Height", "height"],
    ["Padding", "padding"],
    ["Margin", "margin"],
    ["Gap", "gap"],
    ["Font size", "font-size"],
    ["Weight", "font-weight"],
    ["Line height", "line-height"],
    ["Text color", "color"],
    ["Background", "background-color"],
    ["Radius", "border-radius"],
    ["Border", "border"],
    ["Opacity", "opacity"],
  ]) {
    const input = make("input");
    input.type = "text";
    input.setAttribute("aria-label", label!);
    input.addEventListener("input", () => {
      const value = input.value.trim();
      const valid = CSS.supports(property!, value);
      input.setAttribute("aria-invalid", String(!valid));
      if (valid)
        history.setStyleBatch(
          selected.map((element) => ({ element, values: { [property!]: value } })),
        );
      refresh(false);
    });
    input.addEventListener("blur", () => history.checkpoint());
    controls.set(property!, input);
    const row = make("div", "field");
    const caption = make("label");
    input.id = `live-edit-${property}`;
    caption.htmlFor = input.id;
    caption.textContent = label!;
    const value = make("div", "value");
    value.append(input);
    if (!["color", "background-color", "border"].includes(property!)) {
      const dial = make("button", "dial");
      dial.type = "button";
      dial.setAttribute("role", "slider");
      dial.setAttribute("aria-label", `Adjust ${label!.toLowerCase()}`);
      dial.title = "Drag left or right to adjust; Shift for fine control. Arrow keys also work.";
      const step = property === "opacity" ? 0.01 : property === "font-weight" ? 10 : 1;
      const min = property === "margin" ? -10000 : property === "font-weight" ? 1 : 0;
      const max = property === "opacity" ? 1 : property === "font-weight" ? 1000 : 10000;
      dial.setAttribute("aria-valuemin", String(min));
      dial.setAttribute("aria-valuemax", String(max));
      const adjust = (start: { number: number; unit: string }, delta: number) => {
        const scale = start.unit === "em" || start.unit === "rem" ? 0.1 : step;
        const number =
          Math.round(Math.min(max, Math.max(min, start.number + delta * scale)) * 100) / 100;
        input.value = `${number}${start.unit}`;
        input.dispatchEvent(new Event("input"));
      };
      dial.addEventListener("pointerdown", (event) => {
        const start = numericValue(input.value);
        if (start) startDrag(event, (dx, _dy, fine) => adjust(start, dx * (fine ? 0.1 : 1)));
      });
      dial.addEventListener("keydown", (event) => {
        const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
        const start = numericValue(input.value);
        if (!direction || !start || capturing) return;
        event.preventDefault();
        history.checkpoint();
        adjust(start, direction * (event.shiftKey ? 0.1 : 1));
        history.checkpoint();
      });
      dials.set(property!, dial);
      value.append(dial);
    }
    row.append(caption, value);
    fields.append(row);
  }
  const footer = make("div", "footer");
  const status = make("p", "hint");
  status.setAttribute("role", "status");
  const attach = button("Attach edits to chat", () => {
    void submit();
  });
  attach.className = "attach";
  footer.append(status, attach);
  inspector.append(heading, hint, fields, footer);

  const hover = make("div", "outline");
  hover.hidden = true;
  root.append(hover, inspector, bar);

  const position = (box: HTMLElement, element: Element) => {
    const rect = element.getBoundingClientRect();
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.hidden = false;
  };
  function repaint() {
    for (const [element, outline] of outlines) {
      outline.hidden = playing || !element.isConnected;
      if (!outline.hidden) position(outline, element);
    }
    hover.hidden = true;
  }
  function refresh(sync = true) {
    undo.disabled = !history.canUndo || capturing;
    redo.disabled = !history.canRedo || capturing;
    reset.disabled = !history.canUndo || capturing;
    const changes = history.changes();
    attach.disabled = changes.length === 0 || capturing;
    status.textContent = changes.length
      ? `${changes.length} ${changes.length === 1 ? "change" : "changes"} · Attach for the agent to apply to source. Preview only.`
      : history.canUndo
        ? "The page replaced an edited element. Select it again to continue."
        : "No changes yet.";
    const connected = selected.filter((element) => element.isConnected);
    fields.hidden = connected.length === 0;
    const single = connected.length === 1 ? connected[0] : null;
    parent.disabled = !single?.parentElement || single.parentElement === document.documentElement;
    name.textContent =
      connected.length > 1
        ? `${connected.length} elements selected`
        : single
          ? `${single.localName}${single.id ? `#${single.id}` : ""}`
          : "Select an element";
    if (sync && connected.length) {
      const computed = connected.map((element) => getComputedStyle(element));
      for (const [property, input] of controls) {
        const values = connected.map((element, index) => {
          const inline = element.style.getPropertyValue(property).trim();
          return numericValue(inline) ? inline : computed[index]!.getPropertyValue(property).trim();
        });
        const mixed = values.some((value) => value !== values[0]);
        input.value = mixed ? "" : values[0]!;
        input.placeholder = mixed ? "Mixed" : "";
        input.removeAttribute("aria-invalid");
      }
      const node = single ? editableTextNode(single) : null;
      text.disabled = !node;
      text.value = node?.data ?? "";
    }
    for (const [property, dial] of dials) {
      const value = numericValue(controls.get(property)!.value);
      dial.disabled = !value || capturing;
      dial.setAttribute("aria-valuenow", String(value?.number ?? 0));
      dial.setAttribute(
        "aria-valuetext",
        value ? controls.get(property)!.value : "Enter one numeric value to adjust",
      );
      dial.style.setProperty(
        "--turn",
        `${(value?.number ?? 0) * (property === "opacity" ? 270 : 3)}deg`,
      );
    }
    repaint();
  }
  const observer = new ResizeObserver(() => scheduleRepaint());
  function select(element: HTMLElement | SVGElement, additive = false) {
    endDrag();
    observer.disconnect();
    if (!additive) selected = [element];
    else if (selected.includes(element)) selected = selected.filter((item) => item !== element);
    else {
      // A parent and its child cannot move independently as one selection.
      selected = selected.filter((item) => !item.contains(element) && !element.contains(item));
      selected.push(element);
    }
    for (const outline of outlines.values()) outline.remove();
    outlines.clear();
    for (const item of selected) {
      observer.observe(item);
      const outline = make("div", "outline");
      const move = button("Move", () => {});
      move.className = "move";
      move.setAttribute("aria-label", "Move selection");
      move.title = "Drag to move the selection, or use arrow keys (Shift for 10px)";
      move.addEventListener("pointerdown", (event) => beginDrag(event));
      move.addEventListener("keydown", (event) => {
        const direction = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[event.key];
        if (!direction || capturing) return;
        event.preventDefault();
        history.checkpoint();
        const step = event.shiftKey ? 10 : 1;
        history.setStyleBatch(
          selected.map((element) => ({
            element,
            values: {
              transform: translated(
                getComputedStyle(element).transform,
                direction[0]! * step,
                direction[1]! * step,
              ),
            },
          })),
        );
        history.checkpoint();
        refresh();
      });
      outline.append(move);
      for (const corner of ["nw", "ne", "sw", "se"] as const) {
        const handle = make("button", "resize");
        handle.type = "button";
        handle.setAttribute("aria-label", `Resize ${corner}`);
        handle.title = "Drag to resize; use Width and Height for keyboard adjustments";
        handle.style[corner.includes("n") ? "top" : "bottom"] = "-5px";
        handle.style[corner.includes("w") ? "left" : "right"] = "-5px";
        handle.style.cursor = corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
        handle.addEventListener("pointerdown", (event) =>
          beginDrag(event, { element: item, corner }),
        );
        outline.append(handle);
      }
      const radius = make("button", "radius");
      radius.type = "button";
      radius.setAttribute("aria-label", "Adjust corner roundness");
      radius.title = "Drag inward to round all corners; use the Radius dial for precise values";
      radius.addEventListener("pointerdown", (event) => {
        const rect = item.getBoundingClientRect();
        const max = Math.min(rect.width, rect.height) / 2;
        const original = getComputedStyle(item).borderTopLeftRadius;
        const initial = (parseFloat(original) || 0) * (original.endsWith("%") ? max / 50 : 1);
        startDrag(event, (dx, dy, fine) => {
          const value = Math.round(
            Math.max(0, Math.min(max, initial + ((dx + dy) / 2) * (fine ? 0.1 : 1))),
          );
          history.setStyles(item, { "border-radius": `${value}px` });
          refresh();
        });
      });
      outline.append(radius);
      outlines.set(item, outline);
      root.insertBefore(outline, inspector);
    }
    refresh();
  }
  function scheduleRepaint() {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!disposed) repaint();
    });
  }
  const inEditor = (event: Event) => event.composedPath().includes(host);
  const selectable = (target: EventTarget | null): target is HTMLElement | SVGElement =>
    (target instanceof HTMLElement || target instanceof SVGElement) &&
    target !== document.documentElement &&
    !target.matches("script,style,link,meta");
  const pointerMove = (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointer) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      drag.update(dx, dy, event.shiftKey);
      scheduleRepaint();
      return;
    }
    if (playing || capturing || inEditor(event) || !selectable(event.target)) {
      hover.hidden = true;
      return;
    }
    position(hover, event.target);
  };
  const intercept = (event: Event) => {
    if (event.type === "pointerup" && drag) endDrag();
    if (playing || inEditor(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!capturing && event.type === "pointerdown" && selectable(event.target)) {
      const pointer = event as PointerEvent;
      if (pointer.button !== 0) return;
      if (pointer.shiftKey) select(event.target, true);
      else {
        if (!selected.some((element) => element.contains(event.target as Node)))
          select(event.target);
        beginDrag(pointer);
      }
    }
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      options.cancel();
      return;
    }
    if (playing || inEditor(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (capturing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (event.shiftKey) history.redo();
      else history.undo();
      refresh();
    }
  };
  const translated = (transform: string, x: number, y: number) =>
    `translate(${x}px, ${y}px)${transform && transform !== "none" ? ` ${transform}` : ""}`;
  function numericValue(value: string) {
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)?$/.exec(value.trim());
    return match ? { number: Number(match[1]), unit: match[2] ?? "" } : null;
  }
  let drag: {
    x: number;
    y: number;
    pointer: number;
    moved: boolean;
    update: (dx: number, dy: number, fine: boolean) => void;
  } | null = null;
  function startDrag(event: PointerEvent, update: NonNullable<typeof drag>["update"]) {
    if (event.button !== 0 || capturing) return;
    history.checkpoint();
    if (event.currentTarget instanceof HTMLElement && root.contains(event.currentTarget))
      event.currentTarget.focus({ preventScroll: true });
    drag = { x: event.clientX, y: event.clientY, pointer: event.pointerId, moved: false, update };
    event.preventDefault();
    event.stopPropagation();
  }
  function beginDrag(
    event: PointerEvent,
    resize?: { element: HTMLElement | SVGElement; corner: string },
  ) {
    if (!selected.length || event.button !== 0 || capturing) return;
    if (!resize) {
      const targets = selected.map((element) => ({
        element,
        transform: getComputedStyle(element).transform,
      }));
      startDrag(event, (dx, dy) =>
        history.setStyleBatch(
          targets.map(({ element, transform }) => ({
            element,
            values: { transform: translated(transform, Math.round(dx), Math.round(dy)) },
          })),
        ),
      );
      return;
    }
    const { element, corner } = resize;
    const computed = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const px = (value: string) => parseFloat(value) || 0;
    const extraWidth =
      computed.boxSizing === "border-box"
        ? 0
        : px(computed.paddingLeft) +
          px(computed.paddingRight) +
          px(computed.borderLeftWidth) +
          px(computed.borderRightWidth);
    const extraHeight =
      computed.boxSizing === "border-box"
        ? 0
        : px(computed.paddingTop) +
          px(computed.paddingBottom) +
          px(computed.borderTopWidth) +
          px(computed.borderBottomWidth);
    const width = parseFloat(computed.width) || rect.width - extraWidth;
    const height = parseFloat(computed.height) || rect.height - extraHeight;
    const transform = computed.transform;
    startDrag(event, (dx, dy) => {
      const west = corner.includes("w");
      const north = corner.includes("n");
      const nextWidth = Math.max(1, Math.round(width + (west ? -dx : dx)));
      const nextHeight = Math.max(1, Math.round(height + (north ? -dy : dy)));
      history.setStyles(element, {
        width: `${nextWidth}px`,
        height: `${nextHeight}px`,
        ...(west || north
          ? {
              transform: translated(
                transform,
                west ? width - nextWidth : 0,
                north ? height - nextHeight : 0,
              ),
            }
          : {}),
      });
    });
  }
  function endDrag() {
    const moved = drag?.moved;
    drag = null;
    history.checkpoint();
    if (moved) refresh();
  }

  async function submit() {
    if (capturing) return;
    const changes = history.changes();
    if (!changes.length) return;
    capturing = true;
    refresh(false);
    attach.textContent = "Capturing…";
    fields.inert = true;
    mode.disabled = true;
    parent.disabled = true;
    try {
      const targets = [...new Set(changes.map((change) => change.element))];
      const elements = await Promise.all(
        targets.map(async (element, index) => {
          const rect = element.getBoundingClientRect();
          const context = await options.captureElement(element);
          return {
            id: `live-edit-${index}`,
            element: { ...context, selector: context.selector ?? selectorFor(element) },
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        }),
      );
      if (disposed) return;
      const textChanges: string[] = [];
      const styleChanges: PreviewAnnotationPayload["styleChanges"][number][] = [];
      for (const change of changes) {
        const target = elements[targets.indexOf(change.element)]!;
        if ("property" in change)
          styleChanges.push({
            targetId: target.id,
            selector: target.element.selector,
            property: change.property,
            previousValue: change.computedBefore,
            value: change.after.value,
          });
        else
          textChanges.push(
            `${target.id} (${target.element.selector ?? target.element.tagName}): ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`,
          );
      }
      host.style.visibility = "hidden";
      options.attach({
        id: `live-edit-${crypto.randomUUID()}`,
        pageUrl: location.href,
        pageTitle: document.title || null,
        comment: [
          "Apply these live preview edits to the connected project's source. Preserve the existing component and responsive layout conventions. These are local browser previews, not saved source changes.",
          ...textChanges.map((change) => `Text edit: ${change}`),
        ].join("\n"),
        elements,
        regions: [],
        strokes: [],
        styleChanges,
        screenshot: null,
        createdAt: new Date().toISOString(),
      });
    } catch {
      if (disposed) return;
      capturing = false;
      fields.inert = false;
      mode.disabled = false;
      host.style.visibility = "visible";
      attach.textContent = "Attach edits to chat";
      refresh(false);
      status.textContent = "Could not capture edits. Your preview is still here; try again.";
    }
  }

  const blockedEvents = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
  ];
  for (const type of blockedEvents) window.addEventListener(type, intercept, true);
  window.addEventListener("pointermove", pointerMove, true);
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("scroll", scheduleRepaint, true);
  window.addEventListener("resize", scheduleRepaint);
  window.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("blur", endDrag);
  // Keep editor inputs from triggering the inspected application's keyboard shortcuts.
  root.addEventListener("keydown", (event) => event.stopPropagation());
  refresh();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      history.reset();
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      for (const type of blockedEvents) window.removeEventListener(type, intercept, true);
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("scroll", scheduleRepaint, true);
      window.removeEventListener("resize", scheduleRepaint);
      window.removeEventListener("pointercancel", endDrag, true);
      window.removeEventListener("blur", endDrag);
      host.remove();
    },
  };
}

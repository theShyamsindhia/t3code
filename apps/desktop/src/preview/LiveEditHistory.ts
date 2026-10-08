type StyleValue = { value: string; priority: string };
type StyleEdit = {
  element: HTMLElement | SVGElement;
  property: string;
  before: StyleValue;
  declarations: Array<[string, string, string]>;
  after: StyleValue;
  computedBefore: string;
};
type TextEdit = { element: HTMLElement; node: Text; before: string; after: string };
type Edit = StyleEdit | TextEdit;

export function editableTextNode(element: Element): Text | null {
  if (
    !(element instanceof HTMLElement) ||
    element.matches("input, textarea, select, option, script, style, iframe, canvas, video") ||
    element.isContentEditable ||
    element.childNodes.length !== 1
  )
    return null;
  const node = element.firstChild;
  return node instanceof Text ? node : null;
}

function affectedBy(property: string, declaration: string): boolean {
  if (property === "border")
    return declaration.startsWith("border") && !declaration.endsWith("radius");
  if (property === "border-radius")
    return declaration === property || /^border-.*-radius$/.test(declaration);
  if (property === "gap") return ["gap", "row-gap", "column-gap"].includes(declaration);
  if (property === "padding" || property === "margin")
    return declaration === property || declaration.startsWith(`${property}-`);
  return declaration === property;
}

function apply(edit: Edit, forward: boolean): void {
  if ("property" in edit) {
    if (forward)
      edit.element.style.setProperty(edit.property, edit.after.value, edit.after.priority);
    else {
      for (const property of Array.from(edit.element.style)) {
        if (affectedBy(edit.property, property)) edit.element.style.removeProperty(property);
      }
      for (const [property, value, priority] of edit.declarations)
        edit.element.style.setProperty(property, value, priority);
    }
  } else if (edit.node.parentNode === edit.element) {
    edit.node.data = forward ? edit.after : edit.before;
  }
}

/** Page-local edits. Keeping the original nodes and priorities makes undo lossless. */
export function createLiveEditHistory() {
  const undo: Edit[][] = [];
  const redo: Edit[][] = [];
  let mergeKey: string | null = null;

  const record = (edits: Edit[], key: string): boolean => {
    if (edits.length === 0) return false;
    for (const edit of edits) apply(edit, true);
    const previous = undo.at(-1);
    if (
      key === mergeKey &&
      previous?.length === edits.length &&
      previous.every((edit, index) => edit.element === edits[index]?.element)
    ) {
      edits.forEach((edit, index) => {
        previous[index]!.after = edit.after;
      });
    } else undo.push(edits);
    mergeKey = key;
    redo.length = 0;
    return true;
  };

  const setStyleBatch = (
    targets: Array<{ element: HTMLElement | SVGElement; values: Record<string, string> }>,
  ): boolean => {
    const values = targets.flatMap(({ element, values }) =>
      Object.entries(values)
        .filter(([property, value]) => CSS.supports(property, value))
        .map(([property, value]) => ({ element, property, value })),
    );
    if (!values.length) return false;
    const key = values.map(({ property }) => property).join(",");
    const previous = undo.at(-1);
    // Pointer moves reuse the gesture's baseline without reading layout on every update.
    if (
      mergeKey === key &&
      previous?.length === values.length &&
      previous.every(
        (edit, index) =>
          "property" in edit &&
          edit.element === values[index]!.element &&
          edit.property === values[index]!.property,
      )
    ) {
      values.forEach(({ value }, index) => {
        const edit = previous[index]!;
        edit.after = { value, priority: "important" };
        apply(edit, true);
      });
      redo.length = 0;
      return true;
    }
    const edits: StyleEdit[] = values.map(({ element, property, value }) => ({
      element,
      property,
      before: {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      },
      declarations: Array.from(element.style)
        .filter((name) => affectedBy(property, name))
        .map((name) => [
          name,
          element.style.getPropertyValue(name),
          element.style.getPropertyPriority(name),
        ]),
      after: { value, priority: "important" },
      computedBefore: getComputedStyle(element).getPropertyValue(property).trim(),
    }));
    if (
      edits.every(
        (edit) =>
          edit.before.value === edit.after.value && edit.before.priority === edit.after.priority,
      )
    )
      return false;
    return record(edits, key);
  };

  return {
    checkpoint() {
      mergeKey = null;
    },
    setStyleBatch,
    setStyles(element: HTMLElement | SVGElement, values: Record<string, string>): boolean {
      return setStyleBatch([{ element, values }]);
    },
    setText(element: HTMLElement, value: string): boolean {
      const node = editableTextNode(element);
      if (!node || node.data === value) return false;
      return record([{ element, node, before: node.data, after: value }], "text");
    },
    undo() {
      mergeKey = null;
      const edits = undo.pop();
      if (!edits) return;
      for (const edit of edits.toReversed()) apply(edit, false);
      redo.push(edits);
    },
    redo() {
      mergeKey = null;
      const edits = redo.pop();
      if (!edits) return;
      for (const edit of edits) apply(edit, true);
      undo.push(edits);
    },
    reset() {
      for (const edits of undo.toReversed())
        for (const edit of edits.toReversed()) apply(edit, false);
      undo.length = 0;
      redo.length = 0;
      mergeKey = null;
    },
    get canUndo() {
      return undo.length > 0;
    },
    get canRedo() {
      return redo.length > 0;
    },
    changes(): Edit[] {
      const result: Edit[] = [];
      for (const edits of undo)
        for (const edit of edits) {
          if (!edit.element.isConnected) continue;
          if (!("property" in edit) && edit.node.parentNode !== edit.element) continue;
          const existing = result.find(
            (candidate) =>
              candidate.element === edit.element &&
              ("property" in candidate && "property" in edit
                ? candidate.property === edit.property
                : !("property" in candidate) && !("property" in edit)),
          );
          if (existing) existing.after = edit.after;
          else result.push({ ...edit });
        }
      return result.filter((edit) =>
        "property" in edit ? edit.computedBefore !== edit.after.value : edit.before !== edit.after,
      );
    },
  };
}

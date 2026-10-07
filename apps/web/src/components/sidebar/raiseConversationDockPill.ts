const raisedPills = new WeakMap<HTMLElement, () => void>();

/** Lift the actual row out of the scroller's clip, keeping its place in the dock. */
export function raiseConversationDockPill(row: HTMLElement) {
  raisedPills.get(row)?.();
  const slot = row.closest<HTMLElement>("[data-thread-item]");
  if (!slot) return () => {};

  row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const rect = row.getBoundingClientRect();
  // Animate the visible radius, not the oversized CSS value that makes a pill.
  const radius = `${Math.min(
    Number.parseFloat(getComputedStyle(row).borderRadius),
    rect.width / 2,
    rect.height / 2,
  )}px`;
  slot.style.setProperty("--dock-pill-height", `${rect.height}px`);
  row.dataset.dockPreviewRaised = "";
  row.setAttribute("popover", "manual");

  const position = () => {
    const anchor = slot.getBoundingClientRect();
    row.style.setProperty("--dock-preview-left", `${anchor.left}px`);
    row.style.setProperty("--dock-preview-bottom", `${window.innerHeight - anchor.bottom}px`);
    row.style.setProperty("--dock-preview-width", `${anchor.width}px`);
    row.style.setProperty(
      "--dock-preview-body-height",
      `${Math.min(168, Math.max(0, anchor.top - 16))}px`,
    );
  };
  position();
  row.showPopover();
  const expanded = getComputedStyle(row);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let animation = reducedMotion
    ? null
    : row.animate(
        [
          {
            height: `${rect.height}px`,
            paddingTop: "0px",
            borderRadius: radius,
            transform: "translateY(0)",
          },
          {
            height: expanded.height,
            paddingTop: expanded.paddingTop,
            borderRadius: expanded.borderRadius,
            transform: expanded.transform,
          },
        ],
        { duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );

  const restore = () => {
    if (raisedPills.get(row) !== restore) return;
    raisedPills.delete(row);
    animation?.cancel();
    if (row.isConnected) row.hidePopover();
    row.removeAttribute("popover");
    delete row.dataset.dockPreviewRaised;
    slot.style.removeProperty("--dock-pill-height");
    for (const property of ["left", "bottom", "width", "body-height"]) {
      row.style.removeProperty(`--dock-preview-${property}`);
    }
  };
  raisedPills.set(row, restore);
  const observer = new ResizeObserver(position);
  observer.observe(slot);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);

  return () => {
    observer.disconnect();
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    if (!animation || !row.isConnected) {
      restore();
      return;
    }
    const current = getComputedStyle(row);
    const from = {
      height: current.height,
      paddingTop: current.paddingTop,
      borderRadius: current.borderRadius,
      transform: current.transform,
    };
    animation.cancel();
    animation = row.animate(
      [
        from,
        {
          height: `${rect.height}px`,
          paddingTop: "0px",
          borderRadius: radius,
          transform: "translateY(0)",
        },
      ],
      { duration: 120, easing: "ease-in", fill: "forwards" },
    );
    void animation.finished.then(restore, () => {});
  };
}

import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth } from "./PreviewPanelShell";

describe("getPreviewPanelMaxWidth", () => {
  it("reserves the sibling column minimum beside an open app sidebar", () => {
    expect(getPreviewPanelMaxWidth(1_256)).toBe(896);
  });

  it("reserves the same sibling minimum when the app sidebar is closed", () => {
    // The row is the whole 1800px viewport; the chat still keeps only 360px,
    // not 30% of the viewport.
    expect(getPreviewPanelMaxWidth(1_800)).toBe(1_440);
  });

  it("has no pixel ceiling on ultra-wide rows", () => {
    expect(getPreviewPanelMaxWidth(6_000)).toBe(5_640);
  });

  it("rounds fractional row widths down", () => {
    expect(getPreviewPanelMaxWidth(1_256.6)).toBe(896);
  });

  it("never drops below the panel minimum when the row cannot fit both columns", () => {
    expect(getPreviewPanelMaxWidth(700)).toBe(360);
  });

  it("stays at the panel minimum even when the row is narrower than the reservation", () => {
    expect(getPreviewPanelMaxWidth(300)).toBe(360);
  });
});

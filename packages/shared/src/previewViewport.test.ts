import { PreviewAutomationResizeInput, PreviewViewportSetting } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PREVIEW_VIEWPORT_PRESETS, resolvePreviewViewport } from "./previewViewport.ts";

const decodeResizeInput = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodeViewport = Schema.decodeSync(PreviewViewportSetting);

describe("previewViewport", () => {
  it("resolves fill and exact freeform viewports", () => {
    expect(resolvePreviewViewport({ mode: "fill" })).toEqual({ _tag: "fill" });
    expect(resolvePreviewViewport({ mode: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
  });

  it("resolves device presets in either orientation", () => {
    expect(resolvePreviewViewport({ mode: "preset", preset: "iphone-12-pro" })).toEqual({
      _tag: "preset",
      width: 390,
      height: 844,
      presetId: "iphone-12-pro",
    });
    expect(
      resolvePreviewViewport({
        mode: "preset",
        preset: "iphone-12-pro",
        orientation: "landscape",
      }),
    ).toEqual({
      _tag: "preset",
      width: 844,
      height: 390,
      presetId: "iphone-12-pro",
    });
  });

  it.each([
    ["laptop-1280x800", 1280, 800],
    ["laptop-1366x768", 1366, 768],
    ["desktop-1440x900", 1440, 900],
    ["desktop-1920x1080", 1920, 1080],
    ["desktop-2560x1440", 2560, 1440],
    ["desktop-3840x2160", 3840, 2160],
    ["desktop-3440x1440", 3440, 1440],
  ])("resolves %s through resize and persisted viewport contracts", (preset, width, height) => {
    const input = decodeResizeInput({
      mode: "preset",
      preset,
    });
    const viewport = resolvePreviewViewport(input);
    expect(decodeViewport(viewport)).toEqual({
      _tag: "preset",
      presetId: preset,
      width,
      height,
    });
  });

  it("rotates a desktop to portrait without changing the preset or exceeding render limits", () => {
    const input = decodeResizeInput({
      mode: "preset",
      preset: "desktop-3840x2160",
      orientation: "portrait",
    });
    expect(decodeViewport(resolvePreviewViewport(input))).toEqual({
      _tag: "preset",
      presetId: "desktop-3840x2160",
      width: 2160,
      height: 3840,
    });
  });

  it("keeps Chrome's phone and tablet ordering", () => {
    expect(
      PREVIEW_VIEWPORT_PRESETS.filter((preset) => preset.category !== "Desktop").map(
        (preset) => preset.label,
      ),
    ).toEqual([
      "iPhone SE",
      "iPhone XR",
      "iPhone 12 Pro",
      "iPhone 14 Pro Max",
      "Pixel 7",
      "Samsung Galaxy S8+",
      "Samsung Galaxy S20 Ultra",
      "iPad Mini",
      "iPad Air",
      "iPad Pro",
      "Surface Pro 7",
      "Surface Duo",
      "Galaxy Z Fold 5",
      "Asus Zenbook Fold",
      "Samsung Galaxy A51/71",
      "Nest Hub",
      "Nest Hub Max",
    ]);
  });
});

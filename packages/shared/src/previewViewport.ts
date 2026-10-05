import type {
  PreviewAutomationResizeInput,
  PreviewViewportPresetId,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESET_IDS } from "@t3tools/contracts";

export interface PreviewViewportPreset {
  readonly id: PreviewViewportPresetId;
  readonly label: string;
  readonly category: "Desktop" | "Tablet" | "Phone";
  readonly detail: string;
  readonly width: number;
  readonly height: number;
}

type PreviewViewportPresetDefinition = Omit<PreviewViewportPreset, "id">;

// Computer presets are CSS viewport sizes, independent of screen pixel density.
// Phones and tablets keep Chromium's EmulatedDevices.ts standard catalog order.
const PREVIEW_VIEWPORT_PRESET_DEFINITIONS = {
  "laptop-1280x800": {
    label: "Compact laptop",
    category: "Desktop",
    detail: "1280 × 800",
    width: 1280,
    height: 800,
  },
  "laptop-1366x768": {
    label: "Laptop",
    category: "Desktop",
    detail: "1366 × 768",
    width: 1366,
    height: 768,
  },
  "desktop-1440x900": {
    label: "Large laptop",
    category: "Desktop",
    detail: "1440 × 900",
    width: 1440,
    height: 900,
  },
  "desktop-1920x1080": {
    label: "Full HD desktop",
    category: "Desktop",
    detail: "1920 × 1080",
    width: 1920,
    height: 1080,
  },
  "desktop-2560x1440": {
    label: "QHD desktop",
    category: "Desktop",
    detail: "2560 × 1440",
    width: 2560,
    height: 1440,
  },
  "desktop-3840x2160": {
    label: "4K desktop",
    category: "Desktop",
    detail: "3840 × 2160",
    width: 3840,
    height: 2160,
  },
  "desktop-3440x1440": {
    label: "Ultrawide desktop",
    category: "Desktop",
    detail: "3440 × 1440",
    width: 3440,
    height: 1440,
  },
  "iphone-se": {
    label: "iPhone SE",
    category: "Phone",
    detail: "375 × 667",
    width: 375,
    height: 667,
  },
  "iphone-xr": {
    label: "iPhone XR",
    category: "Phone",
    detail: "414 × 896",
    width: 414,
    height: 896,
  },
  "iphone-12-pro": {
    label: "iPhone 12 Pro",
    category: "Phone",
    detail: "390 × 844",
    width: 390,
    height: 844,
  },
  "iphone-14-pro-max": {
    label: "iPhone 14 Pro Max",
    category: "Phone",
    detail: "430 × 932",
    width: 430,
    height: 932,
  },
  "pixel-7": {
    label: "Pixel 7",
    category: "Phone",
    detail: "412 × 915",
    width: 412,
    height: 915,
  },
  "samsung-galaxy-s8-plus": {
    label: "Samsung Galaxy S8+",
    category: "Phone",
    detail: "360 × 740",
    width: 360,
    height: 740,
  },
  "samsung-galaxy-s20-ultra": {
    label: "Samsung Galaxy S20 Ultra",
    category: "Phone",
    detail: "412 × 915",
    width: 412,
    height: 915,
  },
  "ipad-mini": {
    label: "iPad Mini",
    category: "Tablet",
    detail: "768 × 1024",
    width: 768,
    height: 1024,
  },
  "ipad-air": {
    label: "iPad Air",
    category: "Tablet",
    detail: "820 × 1180",
    width: 820,
    height: 1180,
  },
  "ipad-pro": {
    label: "iPad Pro",
    category: "Tablet",
    detail: "1024 × 1366",
    width: 1024,
    height: 1366,
  },
  "surface-pro-7": {
    label: "Surface Pro 7",
    category: "Tablet",
    detail: "912 × 1368",
    width: 912,
    height: 1368,
  },
  "surface-duo": {
    label: "Surface Duo",
    category: "Phone",
    detail: "540 × 720",
    width: 540,
    height: 720,
  },
  "galaxy-z-fold-5": {
    label: "Galaxy Z Fold 5",
    category: "Phone",
    detail: "344 × 882",
    width: 344,
    height: 882,
  },
  "asus-zenbook-fold": {
    label: "Asus Zenbook Fold",
    category: "Tablet",
    detail: "853 × 1280",
    width: 853,
    height: 1280,
  },
  "samsung-galaxy-a51-71": {
    label: "Samsung Galaxy A51/71",
    category: "Phone",
    detail: "412 × 914",
    width: 412,
    height: 914,
  },
  "nest-hub": {
    label: "Nest Hub",
    category: "Tablet",
    detail: "1024 × 600",
    width: 1024,
    height: 600,
  },
  "nest-hub-max": {
    label: "Nest Hub Max",
    category: "Tablet",
    detail: "1280 × 800",
    width: 1280,
    height: 800,
  },
} as const satisfies Record<PreviewViewportPresetId, PreviewViewportPresetDefinition>;

export const PREVIEW_VIEWPORT_PRESETS: ReadonlyArray<PreviewViewportPreset> =
  PREVIEW_VIEWPORT_PRESET_IDS.map((id) => ({
    id,
    ...PREVIEW_VIEWPORT_PRESET_DEFINITIONS[id],
  }));

export const PREVIEW_VIEWPORT_PRESET_GROUPS = [
  {
    label: "Laptops & desktops",
    presets: PREVIEW_VIEWPORT_PRESETS.filter((preset) => preset.category === "Desktop"),
  },
  {
    label: "Phones & tablets",
    presets: PREVIEW_VIEWPORT_PRESETS.filter((preset) => preset.category !== "Desktop"),
  },
] as const;

export function resolvePreviewViewport(
  input: PreviewAutomationResizeInput,
): PreviewViewportSetting {
  if (input.mode === "fill") return { _tag: "fill" };
  if (input.mode === "preset" && input.preset !== undefined) {
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === input.preset);
    if (!preset) throw new Error(`Unknown preview viewport preset: ${input.preset}`);
    const landscape = input.orientation === "landscape";
    const portrait = input.orientation === "portrait";
    const nativePortrait = preset.height >= preset.width;
    const shouldSwap = (landscape && nativePortrait) || (portrait && !nativePortrait);
    return {
      _tag: "preset",
      width: shouldSwap ? preset.height : preset.width,
      height: shouldSwap ? preset.width : preset.height,
      presetId: preset.id,
    };
  }
  if (input.width === undefined || input.height === undefined) {
    throw new Error("Custom preview viewport requires width and height");
  }
  return {
    _tag: "freeform",
    width: input.width,
    height: input.height,
  };
}

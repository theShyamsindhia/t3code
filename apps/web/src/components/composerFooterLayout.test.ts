import { describe, expect, it } from "vite-plus/test";

import { resolveContextStripLabelsCompact } from "./BranchToolbar.logic";
import {
  resolveComposerRestingTweenTiming,
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsNaturalWidth,
} from "./composerFooterLayout";

describe("context strip labels and resting composer controls", () => {
  const stripWidth = 724;
  const labelWidth = 327;
  const chromeWidth = 125;
  const measurement = {
    gap: 4,
    naturalFixedWidth: 96.3828125 + 5 + 4,
    minimumFixedWidth: 52 + 5 + 4,
    blockWidths: [130.6953125, 119.671875],
    overflowWidth: 28,
  };
  const naturalWidth = resolveRestingComposerControlsNaturalWidth(measurement);

  function hostWidth(compact: boolean): number {
    return stripWidth - chromeWidth - (compact ? 0 : labelWidth);
  }

  it("keeps the labels compact when the full controls only fit beside compact labels", () => {
    const layout = resolveRestingComposerControlsLayout({
      ...measurement,
      hostWidth: hostWidth(true),
    });
    expect(layout).toEqual({ hiddenCount: 0, visible: true });

    const compact = resolveContextStripLabelsCompact({
      compact: true,
      neededWidth: chromeWidth + labelWidth + naturalWidth,
      availableWidth: stripWidth,
    });
    expect(compact).toBe(true);

    expect(
      resolveRestingComposerControlsLayout({ ...measurement, hostWidth: hostWidth(compact) }),
    ).toEqual(layout);
  });
});

describe("resolveRestingComposerControlsLayout hysteresis", () => {
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
    minimumFixedWidth: 105,
    blockWidths: [60, 140],
    overflowWidth: 24,
  };

  it("settles when the measured picker width jitters below a pixel", () => {
    let layout = { hiddenCount: 0, visible: true };
    const settled: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      layout = resolveRestingComposerControlsLayout({
        ...base,
        naturalFixedWidth: index % 2 === 0 ? 149 : 149.5,
        hostWidth: 357,
        previous: layout,
      });
      if (index >= 2) settled.push(`${layout.hiddenCount}:${layout.visible}`);
    }
    expect(new Set(settled).size).toBe(1);
  });
});

describe("progressive composer controls", () => {
  const measurement = {
    gap: 4,
    naturalFixedWidth: 140,
    minimumFixedWidth: 80,
    blockWidths: [80, 140],
    iconOnlyBlockWidths: [40, 60],
    overflowWidth: 24,
  };

  it("settles through fractional label-width changes at each threshold", () => {
    for (const hostWidth of [368, 288, 248]) {
      let previous = resolveRestingComposerControlsLayout({ ...measurement, hostWidth });
      for (let index = 0; index < 10; index += 1) {
        const next = resolveRestingComposerControlsLayout({
          ...measurement,
          hostWidth,
          previous,
          naturalFixedWidth: 140 + (index % 2) * 0.5,
        });
        if (index > 1) expect(next).toEqual(previous);
        previous = next;
      }
    }
  });
});

describe("resolveComposerRestingTweenTiming", () => {
  const inFlight = {
    renderedHeight: 80,
    startTime: 1_000,
    currentTime: 60,
    durationMs: 200,
    fromHeight: 50,
    targetHeight: 102,
  };

  it("starts a default-length tween from the settled height when nothing is in flight", () => {
    expect(
      resolveComposerRestingTweenTiming({
        stateChanged: true,
        defaultDurationMs: 200,
        nextHeight: 102,
        settledHeight: 50,
        interrupted: null,
      }),
    ).toEqual({ fromHeight: 50, durationMs: 200, remainingMs: 200, startTime: null });
  });

  it("keeps the original start and clock when a retarget lands on the same destination", () => {
    expect(
      resolveComposerRestingTweenTiming({
        stateChanged: false,
        defaultDurationMs: 200,
        nextHeight: 102.2,
        settledHeight: 50,
        interrupted: inFlight,
      }),
    ).toEqual({ fromHeight: 50, durationMs: 200, remainingMs: 140, startTime: 1_000 });
  });

  it("retargets a new destination from the rendered height without restarting the clock", () => {
    expect(
      resolveComposerRestingTweenTiming({
        stateChanged: false,
        defaultDurationMs: 200,
        nextHeight: 240,
        settledHeight: 50,
        interrupted: inFlight,
      }),
    ).toEqual({ fromHeight: 80, durationMs: 140, remainingMs: 140, startTime: "now" });
  });

  it("gives a reversed state change a fresh tween from the rendered height", () => {
    expect(
      resolveComposerRestingTweenTiming({
        stateChanged: true,
        defaultDurationMs: 200,
        nextHeight: 50,
        settledHeight: 102,
        interrupted: inFlight,
      }),
    ).toEqual({ fromHeight: 80, durationMs: 200, remainingMs: 200, startTime: null });
  });
});

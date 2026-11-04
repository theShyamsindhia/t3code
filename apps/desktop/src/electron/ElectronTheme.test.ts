import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

import type { LinuxColorScheme } from "./LinuxColorScheme.ts";

const { onMock, removeListenerMock, themeState } = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  themeState: {
    shouldUseDarkColors: true,
    prefersReducedTransparency: false,
    themeSource: "system",
    setSourceError: null as unknown,
  },
}));

vi.mock("electron", () => ({
  nativeTheme: {
    get prefersReducedTransparency() {
      return themeState.prefersReducedTransparency;
    },
    get shouldUseDarkColors() {
      return themeState.shouldUseDarkColors;
    },
    get themeSource() {
      return themeState.themeSource;
    },
    set themeSource(value: string) {
      if (themeState.setSourceError !== null) {
        throw themeState.setSourceError;
      }
      themeState.themeSource = value;
    },
    on: onMock,
    removeListener: removeListenerMock,
  },
}));

import * as ElectronTheme from "./ElectronTheme.ts";

function setup() {
  const portal: { report: (scheme: LinuxColorScheme) => void; stopped: boolean } = {
    report: () => undefined,
    stopped: false,
  };
  const watch = (onChange: (scheme: LinuxColorScheme) => void) => {
    portal.report = onChange;
    return {
      stop: () => {
        portal.stopped = true;
      },
    };
  };
  return { portal, watch };
}

describe("ElectronTheme", () => {
  beforeEach(() => {
    onMock.mockClear();
    removeListenerMock.mockClear();
    themeState.shouldUseDarkColors = true;
    themeState.prefersReducedTransparency = false;
    themeState.themeSource = "system";
    themeState.setSourceError = null;
  });

  it.effect("respects Reduce transparency and removes vibrancy when switching themes", () =>
    Effect.gen(function* () {
      const theme = yield* ElectronTheme.ElectronTheme;
      yield* theme.setSource("light", true);
      assert.isTrue(yield* theme.shouldUseVibrancy);
      themeState.prefersReducedTransparency = true;
      assert.isFalse(yield* theme.shouldUseVibrancy);
      themeState.prefersReducedTransparency = false;
      yield* theme.setSource("dark");
      assert.isFalse(yield* theme.shouldUseVibrancy);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("keeps the glass style while accessibility disables transparency", () =>
    Effect.gen(function* () {
      const theme = yield* ElectronTheme.ElectronTheme;
      yield* theme.setSource("dark", true, "clear");
      assert.strictEqual(yield* theme.glassStyle, "clear");
      themeState.prefersReducedTransparency = true;
      assert.isFalse(yield* theme.shouldUseVibrancy);
      assert.strictEqual(yield* theme.glassStyle, "clear");
      yield* theme.setSource("dark", true);
      assert.strictEqual(yield* theme.glassStyle, "regular");
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("scopes native theme update listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronTheme = yield* ElectronTheme.ElectronTheme;
          yield* electronTheme.onUpdated(listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["updated", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["updated", listener]]);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("preserves the requested source and cause when setting the theme fails", () =>
    Effect.gen(function* () {
      const cause = new Error("theme source failed");
      themeState.setSourceError = cause;
      const electronTheme = yield* ElectronTheme.ElectronTheme;

      const error = yield* Effect.flip(electronTheme.setSource("dark"));

      assert.instanceOf(error, ElectronTheme.ElectronThemeSetSourceError);
      assert.strictEqual(error.source, "dark");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "dark");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("resolves the system appearance from the desktop color scheme as it changes", () =>
    Effect.gen(function* () {
      const { portal, watch } = setup();
      const theme = yield* ElectronTheme.makeWith(watch);
      yield* theme.setSource("system");

      portal.report("dark");
      assert.equal(themeState.themeSource, "dark");
      portal.report("light");
      assert.equal(themeState.themeSource, "light");
      portal.report(null);
      assert.equal(themeState.themeSource, "system");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an explicit appearance over the desktop color scheme", () =>
    Effect.gen(function* () {
      const { portal, watch } = setup();
      const theme = yield* ElectronTheme.makeWith(watch);
      portal.report("dark");

      yield* theme.setSource("light");
      portal.report("dark");
      assert.equal(themeState.themeSource, "light");

      yield* theme.setSource("system");
      assert.equal(themeState.themeSource, "dark");
    }).pipe(Effect.scoped),
  );

  it.effect("stops following the desktop when the layer is released", () =>
    Effect.gen(function* () {
      const { portal, watch } = setup();
      yield* ElectronTheme.makeWith(watch).pipe(Effect.scoped);
      assert.isTrue(portal.stopped);
    }),
  );

  it.effect("leaves the system appearance to Electron when the portal is unavailable", () =>
    Effect.gen(function* () {
      const theme = yield* ElectronTheme.makeWith(() => {
        throw new Error("no session bus");
      });
      yield* theme.setSource("system");
      assert.equal(themeState.themeSource, "system");
    }).pipe(Effect.scoped),
  );
});

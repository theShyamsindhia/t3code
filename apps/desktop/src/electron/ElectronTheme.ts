import { DesktopThemeSchema, type DesktopTheme, type DesktopGlassStyle } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export class ElectronThemeSetSourceError extends Schema.TaggedError<ElectronThemeSetSourceError>()(
  "ElectronThemeSetSourceError",
  {
    source: DesktopThemeSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to set the Electron theme source to ${this.source}.`;
  }
}

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly glassStyle: Effect.Effect<DesktopGlassStyle>;
    readonly shouldUseVibrancy: Effect.Effect<boolean>;
    readonly setSource: (
      theme: DesktopTheme,
      vibrancy?: boolean,
      glassStyle?: DesktopGlassStyle,
    ) => Effect.Effect<void, ElectronThemeSetSourceError>;
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

let requestedVibrancy = false;
let requestedGlassStyle: DesktopGlassStyle = "regular";

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronTheme.of({
  glassStyle: Effect.sync(() => requestedGlassStyle),
  shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
  shouldUseVibrancy: Effect.sync(
    () => requestedVibrancy && !Electron.nativeTheme.prefersReducedTransparency,
  ),
  setSource: (theme, vibrancy = false, glassStyle = "regular") =>
    Effect.try({
      try: () => {
        Electron.nativeTheme.themeSource = theme;
        requestedVibrancy = vibrancy;
        requestedGlassStyle = glassStyle;
      },
      catch: (cause) => new ElectronThemeSetSourceError({ source: theme, cause }),
    }),
  onUpdated: (listener) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        Electron.nativeTheme.on("updated", listener);
        return Effect.void;
      }),
      () =>
        Effect.suspend(() => {
          Electron.nativeTheme.removeListener("updated", listener);
          return Effect.void;
        }),
    ),
});

export const layer = Layer.succeed(ElectronTheme, make);

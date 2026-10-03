import type { DesktopGlassStyle } from "@t3tools/contracts";
import type { BrowserWindow } from "electron";

export interface MacosGlassView {
  readonly setStyle: (style: DesktopGlassStyle) => void;
  readonly setDarkAppearance: (dark: boolean) => void;
  readonly setCornerRadius: (radius: number) => void;
  readonly remove: () => void;
}

export interface MacosGlassApi {
  readonly addView: (handle: Buffer) => MacosGlassView;
}

/** One native view per window. Detached views are released by AppKit. */
export function createMacosGlassController(api: MacosGlassApi) {
  const views = new WeakMap<BrowserWindow, MacosGlassView>();
  return {
    sync(
      window: BrowserWindow,
      enabled: boolean,
      dark: boolean,
      style: DesktopGlassStyle = "regular",
    ) {
      if (window.isDestroyed()) return;
      const existing = views.get(window);
      if (!enabled) {
        existing?.remove();
        views.delete(window);
      } else if (existing) {
        existing.setDarkAppearance(dark);
        existing.setStyle(style);
      } else {
        const view = api.addView(window.getNativeWindowHandle());
        try {
          view.setDarkAppearance(dark);
          view.setStyle(style);
          view.setCornerRadius(window.isFullScreen() ? 0 : 16);
        } catch (error) {
          view.remove();
          throw error;
        }
        views.set(window, view);
      }
    },
    syncCorners(window: BrowserWindow) {
      if (!window.isDestroyed()) {
        views.get(window)?.setCornerRadius(window.isFullScreen() ? 0 : 16);
      }
    },
  };
}

/** Main-process only. Uses public AppKit APIs; older macOS returns no glass API. */
export async function loadMacosGlassApi(): Promise<MacosGlassApi | null> {
  const { DataType, load, open } = await import("ffi-rs");
  const library = "t3-appkit-glass";
  open({ library, path: "/usr/lib/libobjc.A.dylib" });

  const lookup = (funcName: string, name: string) =>
    load({
      library,
      funcName,
      retType: DataType.BigInt,
      paramsType: [DataType.String],
      paramsValue: [name],
    }) as bigint;
  const glassClass = lookup("objc_getClass", "NSGlassEffectView");
  if (glassClass === 0n) return null;

  // Explicit signatures keep pointers at 64 bits on both Intel and Apple Silicon.
  // Calls stay synchronous on Electron's AppKit thread (never runInNewThread).
  const get = (receiver: bigint, selector: string, ...args: bigint[]) =>
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.BigInt,
      paramsType: [DataType.BigInt, DataType.BigInt, ...args.map(() => DataType.BigInt)],
      paramsValue: [receiver, lookup("sel_registerName", selector), ...args],
    }) as bigint;
  const send = (
    receiver: bigint,
    selector: string,
    types: import("ffi-rs").DataType[] = [],
    values: unknown[] = [],
  ) => {
    load({
      library,
      funcName: "objc_msgSend",
      retType: DataType.Void,
      paramsType: [DataType.BigInt, DataType.BigInt, ...types],
      paramsValue: [receiver, lookup("sel_registerName", selector), ...values],
    });
  };
  const onMainThread = load({
    library,
    funcName: "objc_msgSend",
    retType: DataType.Boolean,
    paramsType: [DataType.BigInt, DataType.BigInt],
    paramsValue: [lookup("objc_getClass", "NSThread"), lookup("sel_registerName", "isMainThread")],
  });
  if (!onMainThread) throw new Error("AppKit glass must be created on the main thread.");

  return {
    addView(handle) {
      const parent = handle.readBigUInt64LE();
      const view = get(get(glassClass, "alloc"), "init");
      if (view === 0n) throw new Error("AppKit could not create a glass view.");
      try {
        send(view, "setTranslatesAutoresizingMaskIntoConstraints:", [DataType.Boolean], [false]);
        send(
          parent,
          "addSubview:positioned:relativeTo:",
          [DataType.BigInt, DataType.I64, DataType.BigInt],
          [view, -1, 0n],
        );
        // Native constraints follow resize/fullscreen without a JS resize loop.
        for (const edge of ["leadingAnchor", "trailingAnchor", "topAnchor", "bottomAnchor"]) {
          const constraint = get(get(view, edge), "constraintEqualToAnchor:", get(parent, edge));
          send(constraint, "setActive:", [DataType.Boolean], [true]);
        }
      } catch (error) {
        send(view, "removeFromSuperview");
        throw error;
      } finally {
        // The superview owns it now; window destruction releases it naturally.
        send(view, "release");
      }
      return {
        setDarkAppearance(dark) {
          const name = load({
            library,
            funcName: "objc_msgSend",
            retType: DataType.BigInt,
            paramsType: [DataType.BigInt, DataType.BigInt, DataType.String],
            paramsValue: [
              lookup("objc_getClass", "NSString"),
              lookup("sel_registerName", "stringWithUTF8String:"),
              dark ? "NSAppearanceNameDarkAqua" : "NSAppearanceNameAqua",
            ],
          }) as bigint;
          const appearance = get(lookup("objc_getClass", "NSAppearance"), "appearanceNamed:", name);
          send(view, "setAppearance:", [DataType.BigInt], [appearance]);
        },
        setStyle: (style) => send(view, "setStyle:", [DataType.I64], [style === "clear" ? 1 : 0]),
        setCornerRadius: (radius) => send(view, "setCornerRadius:", [DataType.Double], [radius]),
        remove: () => send(view, "removeFromSuperview"),
      };
    },
  };
}

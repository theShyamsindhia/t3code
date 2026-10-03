import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";
import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

/** The actual workspace silhouette: one reading area above a slim chat dock. */
function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeCardPreviewColors;
  clip?: "left" | "right" | undefined;
}) {
  const line = "rgb(127 127 127 / 0.3)";
  return (
    <span
      className="absolute inset-0"
      data-frame-theme={colors.frameTheme ?? "default"}
      style={
        {
          "--conversation-frame": colors.sidebar,
          colorScheme: colors.appearance,
          background: "var(--frame-paint, var(--conversation-frame))",
          ...(clip ? { clipPath: clip === "left" ? "inset(0 50% 0 0)" : "inset(0 0 0 50%)" } : {}),
        } as CSSProperties
      }
    >
      <span
        className="absolute inset-x-[2%] top-[3%] bottom-[18%] overflow-hidden rounded-sm"
        style={{ background: colors.canvas }}
      >
        <span
          className="absolute right-[16%] top-[14%] h-[14%] w-[34%] rounded-sm"
          style={{ background: colors.messageSurface }}
        />
        <span
          className="absolute left-[15%] top-[40%] h-[4%] w-[55%] rounded-sm"
          style={{ background: line }}
        />
        <span
          className="absolute left-[15%] top-[50%] h-[4%] w-[40%] rounded-sm"
          style={{ background: line }}
        />
        <span
          className="absolute inset-x-[14%] bottom-[8%] flex h-[23%] items-end justify-end rounded-md p-1"
          style={{ background: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
        >
          <span
            className="block aspect-square h-[60%] rounded-full"
            style={{ background: colors.messageAction }}
          />
        </span>
      </span>
      <span className="absolute inset-x-[4%] bottom-[4%] flex h-[10%] gap-1">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="flex h-full w-[26%] items-center rounded-sm px-1"
            style={{ background: index === 0 ? colors.surface : undefined }}
          >
            <span className="h-[25%] w-full rounded-full" style={{ background: line }} />
          </span>
        ))}
        <span className="ml-auto aspect-square h-full rounded-full" style={{ background: line }} />
      </span>
    </span>
  );
}

export function ThemeWireframe({
  className,
  panes,
}: {
  className?: string;
  panes: ReadonlyArray<{ colors: ThemeCardPreviewColors; clip?: "left" | "right" }>;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border border-border/60",
        className,
      )}
    >
      {panes.map((pane) => (
        <ThemeWireframePane clip={pane.clip} colors={pane.colors} key={pane.clip ?? "pane"} />
      ))}
    </span>
  );
}

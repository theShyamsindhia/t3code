import { PaintbrushIcon } from "lucide-react";
import type { ChatWidgetPresentation } from "@t3tools/contracts";
import { ChatWidget } from "./chat/ChatWidget";

export interface CanvasWidget {
  id: string;
  widget: ChatWidgetPresentation;
}

export function CanvasPanel({
  threadKey,
  widgets,
  theme,
  onSubmit,
}: {
  threadKey: string;
  widgets: readonly CanvasWidget[];
  theme: "light" | "dark";
  onSubmit?: ((text: string) => Promise<boolean>) | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Canvas">
      <header className="shrink-0 border-b border-border/60 px-4 py-3">
        <h2 className="text-sm font-medium">Canvas</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A place for the agent to show an idea you can explore.
        </p>
      </header>
      {widgets.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
          <PaintbrushIcon className="mb-3 size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            The canvas is empty. Ask the agent to make something interactive here.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {[...widgets].reverse().map(({ id, widget }) => (
            <ChatWidget
              key={id}
              widget={widget}
              storageKey={`t3-widget:${threadKey}:${id}`}
              theme={theme}
              onSubmit={onSubmit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

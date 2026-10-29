import { pasteTextToFocusComposer } from "./composerFocusRedirect";
import { readPastedComposerContext } from "../composerInlineTokenPaste";
import { useEffect } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import type { ThreadId } from "@t3tools/contracts";
import type { ComposerHandleRef } from "../../composerHandleContext";
/**
 * Paste-to-focus: the resting composer blurs on a click into the timeline, so a paste that
 * follows has no editable target and would be dropped. This sends it to the composer instead.
 * The composer's own paste-as-text intent decides whether the text skips auto-attachment.
 */
export function usePasteToFocusComposer(
  activeThreadId: ThreadId | null,
  composerRef: ComposerHandleRef,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches a window paste capture listener that routes stray pastes into the composer
  useEffect(() => {
    const handler = (event: ClipboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) return;
      if (getTerminalFocusOwner() !== null) return;
      if (composerRef.current?.isModelPickerOpen()) return;
      const text = pasteTextToFocusComposer(event);
      const clipboardData = event.clipboardData;
      if (text === null || clipboardData === null) return;
      if (
        ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
          composerRef.current?.pasteTextAtEnd(text)) ||
        composerRef.current?.insertTextAtEnd(text, { clipboardData })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("paste", handler, true);
    return () => {
      window.removeEventListener("paste", handler, true);
    };
  }, [activeThreadId, composerRef]);
}

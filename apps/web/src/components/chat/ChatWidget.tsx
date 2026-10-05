import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ChatWidgetPresentation } from "@t3tools/contracts";
import { Ellipsis } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { chatWidgetDocument, readWidgetReply, WIDGET_REPLY_LIMIT } from "./chatWidgetDocument";

function savedReply(storageKey: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "text" in value &&
      "sent" in value &&
      typeof value.text === "string" &&
      value.text.length <= WIDGET_REPLY_LIMIT &&
      typeof value.sent === "boolean"
    )
      return {
        text: value.text,
        sent: value.sent,
        open: !("open" in value) || value.open !== false,
      };
  } catch {
    /* An unavailable local store doesn't prevent using the widget. */
  }
  return { text: "", sent: false, open: true };
}

export function ChatWidget({
  widget,
  storageKey,
  theme,
  onSubmit,
}: {
  widget: ChatWidgetPresentation;
  storageKey: string;
  theme: "light" | "dark";
  onSubmit?: ((text: string) => Promise<boolean>) | undefined;
}) {
  const [reply, setReply] = useState(() => savedReply(storageKey));
  const { open } = reply;
  const [editing, setEditing] = useState(false);
  const [showDescription, setShowDescription] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const replyRef = useRef(reply);
  useEffect(() => {
    replyRef.current = reply;
  }, [reply]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(reply));
      } catch {
        /* Keep the in-memory reply. */
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [reply, storageKey]);
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(replyRef.current));
      } catch {
        /* Keep the in-memory reply. */
      }
    };
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [storageKey]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const text = readWidgetReply(event.data);
      if (text !== null)
        setReply((current) =>
          current.text === text ? current : { ...current, text, sent: false },
        );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <section aria-label={widget.title} className="min-w-0 py-2">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="min-w-0 text-sm font-medium">{widget.title}</h3>
        <div className="flex shrink-0 items-center gap-3 text-xs">
          {!open && (
            <InlineButton onClick={() => setReply((current) => ({ ...current, open: true }))}>
              Open widget
            </InlineButton>
          )}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Widget options" />}
            >
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setShowDescription((current) => !current)}>
                {showDescription ? "Hide instructions" : "Instructions"}
              </MenuItem>
              {open && (
                <>
                  <MenuItem onClick={() => setRevision((current) => current + 1)}>
                    Restart widget
                  </MenuItem>
                  <MenuItem onClick={() => setReply((current) => ({ ...current, open: false }))}>
                    Close widget
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {showDescription && (
        <p className="mb-3 text-sm text-muted-foreground">{widget.description}</p>
      )}
      {open && (
        <WidgetFrame
          key={revision}
          frameRef={frameRef}
          widget={widget}
          theme={theme}
          initialResponse={reply.text}
        />
      )}
      {(reply.text || editing) && (
        <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
          {editing ? (
            <div>
              <Textarea
                autoFocus
                aria-label="Your reply"
                value={reply.text}
                maxLength={WIDGET_REPLY_LIMIT}
                rows={2}
                onChange={(event) =>
                  setReply((current) => ({ ...current, text: event.target.value, sent: false }))
                }
              />
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{reply.text}</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center gap-3 text-xs">
              <InlineButton tone="muted" onClick={() => setEditing((current) => !current)}>
                {editing ? "Done editing" : "Edit reply"}
              </InlineButton>
              <span role="status" className="text-muted-foreground">
                {reply.sent ? "Sent to this chat." : ""}
              </span>
            </div>
            {!reply.sent && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!onSubmit || !reply.text.trim() || sending}
                onClick={async () => {
                  if (!onSubmit || sending) return;
                  const text = reply.text.trim();
                  setSending(true);
                  setError(false);
                  try {
                    const sent = await onSubmit(`My response to “${widget.title}”:\n\n${text}`);
                    setError(!sent);
                    if (sent)
                      setReply((current) =>
                        current.text.trim() === text ? { ...current, sent: true } : current,
                      );
                  } catch {
                    setError(true);
                  } finally {
                    setSending(false);
                  }
                }}
              >
                {sending ? "Sending…" : "Send reply"}
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-xs text-muted-foreground">
              Couldn’t send yet. Your reply is still here.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function WidgetFrame({
  frameRef,
  widget,
  theme,
  initialResponse,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  widget: ChatWidgetPresentation;
  theme: "light" | "dark";
  initialResponse: string;
}) {
  // Freeze the initial reply until reopened/restarted; editing must not reload the widget.
  const [initialReply] = useState(initialResponse);
  const document = useMemo(
    () => chatWidgetDocument(widget, theme, initialReply),
    [widget, theme, initialReply],
  );
  return (
    <iframe
      ref={frameRef}
      title={widget.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      srcDoc={document}
      loading="lazy"
      className="block w-full rounded-lg border-0"
      style={{ height: widget.height }}
    />
  );
}

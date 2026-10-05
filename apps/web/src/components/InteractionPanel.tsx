import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Ellipsis, GripVertical, Pencil, Trash2, Undo2 } from "lucide-react";
import {
  createInteractionDraft,
  formatInteractionReply,
  moveInteractionItem,
  restoreInteractionDraft,
  type InteractionDraft,
  type interactionPresentations,
} from "@t3tools/client-runtime/interaction";
import type { InteractionPresentation } from "@t3tools/contracts";
import { Button, InlineButton } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import "./InteractionPanel.css";

interface InteractionPanelProps {
  threadKey: string;
  presentations: ReturnType<typeof interactionPresentations>;
  disabled: boolean;
  onSubmit: (text: string) => Promise<boolean>;
}

export function InteractionPanel({
  threadKey,
  presentations,
  disabled,
  onSubmit,
}: InteractionPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => presentations.at(-1)?.id ?? null,
  );
  const selected = presentations.find((entry) => entry.id === selectedId) ?? presentations.at(-1);
  if (!selected)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Shared spaces appear here when an agent offers ideas to compare or arrange. Load earlier
        messages to revisit older spaces.
      </p>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {presentations.length > 1 && (
        <div className="px-4 pt-3">
          <Select value={selected.id} onValueChange={(value) => setSelectedId(value)}>
            <SelectTrigger size="sm" aria-label="Presentation">
              <SelectValue>{selected.presentation.title}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {presentations.map((entry, index) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {index + 1}. {entry.presentation.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}
      <InteractionEditor
        key={`${threadKey}:${selected.id}`}
        storageKey={`t3:shared-space:${threadKey}:${selected.id}`}
        presentation={selected.presentation}
        disabled={disabled}
        onSubmit={onSubmit}
      />
    </div>
  );
}

function loadDraft(key: string, presentation: InteractionPresentation) {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return restoreInteractionDraft(saved, presentation);
  } catch {
    return createInteractionDraft(presentation);
  }
}

export function InteractionEditor({
  storageKey,
  presentation,
  disabled,
  onSubmit,
}: {
  storageKey: string;
  presentation: InteractionPresentation;
  disabled: boolean;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => loadDraft(storageKey, presentation));
  const [undo, setUndo] = useState<InteractionDraft[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [showNote, setShowNote] = useState(() => Boolean(draft.note));
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(
    () => new Set(draft.items.filter((item) => item.note).map((item) => item.id)),
  );
  const locked = sending;
  const response = formatInteractionReply(presentation, draft);

  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(draft));
      } catch {
        setSaveError(true);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, storageKey]);
  // Leaving the panel flushes the latest draft without writing on every keystroke.
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(latestDraft.current));
      } catch {
        /* Storage failures are surfaced while the panel is open. */
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [storageKey]);

  function edit(next: InteractionDraft) {
    if (locked || next === draft) return;
    setUndo((history) => [...history.slice(-19), draft]);
    setDraft(next);
    setError(null);
  }

  async function submit() {
    if (disabled || sending || sent === response) return;
    setSending(true);
    setError(null);
    try {
      if (await onSubmit(response)) setSent(response);
      else
        setError(
          "Couldn’t send yet. Your arrangement is still here; try again when the chat is ready.",
        );
    } catch {
      setError("Couldn’t send. Your arrangement is still here; try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div data-interaction-panel className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 text-base font-medium">{presentation.title}</h2>
          <div className="flex shrink-0 items-center gap-1">
            {undo.length > 0 && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Undo"
                title="Undo"
                disabled={locked}
                onClick={() => {
                  const previous = undo.at(-1);
                  if (previous) {
                    setDraft(previous);
                    setUndo((history) => history.slice(0, -1));
                  }
                }}
              >
                <Undo2 />
              </Button>
            )}
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label="Arrangement options" />}
              >
                <Ellipsis />
              </MenuTrigger>
              <MenuPopup align="end" finalFocus={() => !editingGroupId}>
                <MenuItem
                  disabled={locked || draft.groups.length >= 6}
                  onClick={() => {
                    let index = 1;
                    while (draft.groups.some((group) => group.id === `user-group-${index}`))
                      index += 1;
                    edit({
                      ...draft,
                      groups: [...draft.groups, { id: `user-group-${index}`, label: "New group" }],
                    });
                    setEditingGroupId(`user-group-${index}`);
                  }}
                >
                  Add group
                </MenuItem>
                <MenuItem
                  disabled={locked}
                  onClick={() => edit(createInteractionDraft(presentation))}
                >
                  Reset arrangement
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
          {presentation.prompt}
        </p>
        <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-start gap-5">
          {[...draft.groups, { id: null, label: "Unsorted" }].map((group) => {
            const items = draft.items.filter((item) => item.groupId === group.id);
            return (
              <section
                key={group.id ?? "unsorted"}
                aria-label={group.label}
                className="min-w-0"
                onDragOver={(event) => {
                  if (draggedId && !locked) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!draggedId || locked) return;
                  event.preventDefault();
                  edit(moveInteractionItem(draft, draggedId, group.id));
                  setDraggedId(null);
                }}
              >
                <div className="mb-2 flex min-h-8 items-center gap-2">
                  {group.id !== null && editingGroupId === group.id ? (
                    <div className="min-w-0 flex-1">
                      <Input
                        autoFocus
                        aria-label={`Group name: ${group.label}`}
                        value={group.label}
                        maxLength={120}
                        disabled={locked}
                        onBlur={() => setEditingGroupId(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") setEditingGroupId(null);
                        }}
                        onChange={(event) =>
                          edit({
                            ...draft,
                            groups: draft.groups.map((entry) =>
                              entry.id === group.id
                                ? { ...entry, label: event.target.value }
                                : entry,
                            ),
                          })
                        }
                      />
                    </div>
                  ) : (
                    <h3 className="min-w-0 flex-1 break-words text-sm font-medium">
                      {group.label || "Untitled group"}
                    </h3>
                  )}
                  {group.id !== null && editingGroupId !== group.id && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Rename ${group.label} group`}
                      title="Rename group"
                      disabled={locked}
                      onClick={() => setEditingGroupId(group.id)}
                    >
                      <Pencil />
                    </Button>
                  )}
                  <span className="pr-1 text-xs text-muted-foreground">{items.length}</span>
                  {group.id !== null && !items.length && draft.groups.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={locked}
                      title="Remove empty group"
                      aria-label={`Remove ${group.label} group`}
                      onClick={() =>
                        edit({
                          ...draft,
                          groups: draft.groups.filter((entry) => entry.id !== group.id),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {items.map((item, index) => {
                    const original = presentation.items.find((entry) => entry.id === item.id)!;
                    return (
                      <article
                        key={item.id}
                        data-interaction-item
                        data-emphasized={original.emphasis || undefined}
                        aria-label={original.label}
                        draggable={!locked}
                        onDragStart={(event) => {
                          setDraggedId(item.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", item.id);
                        }}
                        onDragEnd={() => setDraggedId(null)}
                        onDrop={(event) => {
                          if (!draggedId || locked) return;
                          event.preventDefault();
                          event.stopPropagation();
                          edit(moveInteractionItem(draft, draggedId, group.id, item.id));
                          setDraggedId(null);
                        }}
                        className={`rounded-md border bg-background p-3 ${original.emphasis ? "border-primary/60" : "border-border"}`}
                      >
                        <div className="flex items-start gap-2">
                          <GripVertical
                            aria-hidden="true"
                            className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                          />
                          <h4 className="break-words text-sm font-medium">{original.label}</h4>
                        </div>
                        {original.detail && (
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                            {original.detail}
                          </p>
                        )}
                        {original.emphasis && (
                          <p className="mt-1 text-xs text-muted-foreground">Emphasized by agent</p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-1">
                          <div className="min-w-0 flex-1">
                            <Select
                              value={item.groupId ?? ""}
                              disabled={locked}
                              onValueChange={(value) =>
                                edit(moveInteractionItem(draft, item.id, value || null))
                              }
                            >
                              <SelectTrigger size="xs" aria-label={`Move ${original.label}`}>
                                <SelectValue>{group.label}</SelectValue>
                              </SelectTrigger>
                              <SelectPopup>
                                <SelectItem value="">Unsorted</SelectItem>
                                {draft.groups.map((entry) => (
                                  <SelectItem key={entry.id} value={entry.id}>
                                    {entry.label || "Untitled group"}
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Move ${original.label} up`}
                            disabled={locked || index === 0}
                            onClick={() =>
                              edit(
                                moveInteractionItem(draft, item.id, group.id, items[index - 1]?.id),
                              )
                            }
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Move ${original.label} down`}
                            disabled={locked || index === items.length - 1}
                            onClick={() =>
                              edit(
                                moveInteractionItem(draft, item.id, group.id, items[index + 2]?.id),
                              )
                            }
                          >
                            <ArrowDown />
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            aria-expanded={openNotes.has(item.id)}
                            onClick={() =>
                              setOpenNotes((previous) => {
                                const next = new Set(previous);
                                if (next.has(item.id)) next.delete(item.id);
                                else next.add(item.id);
                                return next;
                              })
                            }
                          >
                            Note
                          </Button>
                        </div>
                        {openNotes.has(item.id) && (
                          <div className="mt-2">
                            <Textarea
                              aria-label={`Note for ${original.label}`}
                              placeholder="What matters to you?"
                              value={item.note}
                              maxLength={1000}
                              disabled={locked}
                              onChange={(event) =>
                                edit({
                                  ...draft,
                                  items: draft.items.map((entry) =>
                                    entry.id === item.id
                                      ? { ...entry, note: event.target.value }
                                      : entry,
                                  ),
                                })
                              }
                            />
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {!items.length && (
                    <p className="rounded-md border border-dashed border-border px-2 py-5 text-center text-xs text-muted-foreground">
                      Move items here
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        <div className="mt-5 text-xs">
          <InlineButton
            tone="muted"
            aria-expanded={showNote}
            onClick={() => setShowNote((current) => !current)}
          >
            {showNote ? "Hide note" : draft.note ? "Edit note" : "Add a note"}
          </InlineButton>
          {showNote && (
            <div className="mt-2">
              <Textarea
                aria-label="Note about your arrangement"
                placeholder="Anything else the agent should understand?"
                value={draft.note}
                maxLength={2000}
                disabled={locked}
                onChange={(event) => edit({ ...draft, note: event.target.value })}
              />
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3">
        <p className="text-xs text-muted-foreground" role="status">
          {error ??
            (sent === response
              ? "Sent to this chat."
              : saveError
                ? "Draft could not be saved on this device."
                : "")}
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || sending || sent === response}
          onClick={() => void submit()}
        >
          {sending ? "Sending…" : sent === response ? "Sent" : "Send arrangement"}
        </Button>
      </div>
    </div>
  );
}

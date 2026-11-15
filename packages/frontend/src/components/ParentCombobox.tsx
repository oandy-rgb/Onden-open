import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ContentNode } from "../lib/api";
import { useOnline } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import { placementCandidates, type PlacementContext } from "../lib/data";
import { useT } from "../lib/i18n";
import { displayTitle } from "../lib/noteLabel";
import { containsTitle } from "../lib/noteSearch";
import "./ParentCombobox.css";
import { SearchField, keepFocus } from "./ui";

// The one picker for where a note goes in the note tree: a type-to-filter
// combobox (↑/↓ to move, Enter to pick, Esc to close). What it offers is
// lib/data placementCandidates, the one placement rule (D101): for a move,
// never a tag, never the note itself or one of its descendants, never a note
// in another space (moving spaces is the space chip's job), never a trashed
// note, never one the person cannot edit. The candidate list is built only while the
// picker is open: one subtree walk per opening.
//
// Two places show it (the note menu's "Move to…" is PlacePicker now: it also
// picks a space):
//   • "pin" — the note menu's "Pin under another note…" (MoveToDialog): a
//     dialog list, each row with its own parent's title, up to 50 rows, with
//     the pin rule (placementCandidates `pin`: another
//     space and the note's own sub-notes are fine, the note itself is not),
//     and a pin always has a parent, so there is no top level and no current
//     place;
//   • "inline" — the note's Parent field under the body (ParentPicker): the
//     top level only when the note has a parent, plain rows, up to 30, and it
//     closes when it loses focus.

/** The notes `node` may go under (lib/data placementCandidates) whose title
 *  contains `query`, in the order given, at most `limit`. */
export function parentCandidates(
  node: ContentNode, nodes: readonly ContentNode[], query: string, limit = 30, ctx: Omit<PlacementContext, "nodes"> = {},
): ContentNode[] {
  const q = query.trim().toLowerCase();
  const out: ContentNode[] = [];
  for (const n of placementCandidates(node, nodes, ctx)) {
    if (q && !containsTitle(q, n.title || "")) continue;
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

export type ParentComboboxVariant = "inline" | "pin";
type Row = { id: string | null; label: string; hint?: string };

const VARIANTS = {
  pin: { limit: 50, cls: "move-to", topLevel: null, input: "Search notes to pin under…", list: "Notes", empty: "No notes match" },
  inline: { limit: 30, cls: "parent-picker", topLevel: "No parent (top level)", input: "Search parent notes…", list: "Parent notes", empty: "No matches" },
} as const;

type Props = {
  node: ContentNode;
  /** The notes a parent can be picked from (the notes tree). */
  nodes: readonly ContentNode[];
  /** null = the top level (never for "pin"). Not called for the note's
   *  current place ("pin" has none). */
  onPick: (parentId: string | null) => void;
  onClose: () => void;
  variant: ParentComboboxVariant;
};

export function ParentCombobox({ node, nodes, onPick, onClose, variant }: Props) {
  const t = useT();
  const v = VARIANTS[variant];
  const dialog = variant === "pin";
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Hovering a half-visible row only highlights it; scrolling it into view is for the arrow keys
  // (a hover that scrolled the list moved the row out from under the pointer).
  const followActive = useRef(true);
  const canEdit = useCapabilities(useOnline()).canEdit;
  const titles = useMemo(() => new Map(nodes.map((n) => [n.id, displayTitle(n.title)])), [nodes]);
  // One extra match says whether there are more than the list shows.
  const pin = variant === "pin";
  const found = useMemo(() => parentCandidates(node, nodes, query, v.limit + 1, { canEdit, pin }), [node, nodes, query, v.limit, canEdit, pin]);
  const truncated = found.length > v.limit;
  // A pin has no current place: every row is a new one.
  const currentParent = pin ? undefined : node.parent_id ?? null;
  const topLevel = v.topLevel;
  const offerTop = topLevel !== null && (dialog ? !query.trim() : currentParent !== null);
  const rows: Row[] = [
    ...(offerTop && topLevel !== null ? [{ id: null, label: t(topLevel) }] : []),
    ...found.slice(0, v.limit).map((n) => ({
      id: n.id, label: displayTitle(n.title),
      hint: dialog && n.parent_id ? titles.get(n.parent_id) : undefined,
    })),
  ];
  const current = Math.min(active, Math.max(rows.length - 1, 0));
  const choose = (row: Row) => {
    if (row.id !== currentParent) onPick(row.id);
    onClose();
  };

  useEffect(() => {
    if (!followActive.current) { followActive.current = true; return; }
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  return (
    <div className={dialog ? "move-to-picker" : "parent-picker"}>
      <SearchField
        autoFocus
        size={dialog ? "large" : "default"}
        role="combobox"
        label={t(v.input)}
        placeholder={t("Search notes…")}
        aria-expanded={rows.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={rows.length > 0 ? `${listId}-${current}` : undefined}
        value={query}
        onValueChange={(v) => { setQuery(v); setActive(0); }}
        nav={{ count: rows.length, active: current, onActive: setActive, onPick: (i) => { const row = rows[i]; if (row) choose(row); } }}
        onEscape={onClose}
        // The inline field closes when focus leaves it (a press on a row keeps focus, below).
        onBlur={dialog ? undefined : onClose}
      />
      {rows.length > 0 ? (
        <ul ref={listRef} id={listId} className={`${v.cls}-options`} role="listbox" aria-label={t(v.list)}>
          {rows.map((row, i) => {
            const isCurrent = dialog && row.id === currentParent;
            return (
              <li key={row.id ?? "top"} id={`${listId}-${i}`} data-index={i} role="option"
                aria-selected={i === current} aria-current={isCurrent ? "location" : undefined}
                className={i === current ? "active" : undefined}
                onMouseMove={() => { if (i !== current) { followActive.current = false; setActive(i); } }}
                // Keep focus in the input (no blur) while a row is pressed.
                onMouseDown={keepFocus}
                onClick={() => choose(row)}>
                {dialog ? <>
                  <span className="move-to-label">{row.label}</span>
                  {row.hint && <span className="move-to-hint">{row.hint}</span>}
                  {isCurrent && <span className="move-to-current">{t("Current place")}</span>}
                </> : row.label}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={`${v.cls}-empty`} role="status">{t(v.empty)}</p>
      )}
      {truncated && <p className={`${v.cls}-more`}>{t("Type to narrow the list")}</p>}
    </div>
  );
}

import { listsAsNote } from "./nodeTags";
import { byUpdatedDesc } from "./noteOrder";
import { CONTENT_TAB } from "./viewTabs";

// Side by side (docs/agents/decisions-ui.md, 視角＋並排): exactly two panes.
// A pane holds ONE destination — a note's (or tag's) view, or a function page.
// This file is the pure part: the destination type, how it is written in the
// URL and the account pref, which pairs may not share the screen, and where a
// drag lands. The state is lib/splitViewStore.

/** What a pane shows. `tab` is the note's view key: "content", "canvas" or a saved view's id. */
export type PaneTarget =
  | { kind: "note"; id: string; tab: string }
  | { kind: "page"; mode: string };

export type Side = "left" | "right";

export const SPLIT_RATIO_DEFAULT = 0.5;
export const SPLIT_RATIO_MIN = 0.25;
export const SPLIT_RATIO_MAX = 0.75;

export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)) : SPLIT_RATIO_DEFAULT;

/** "note:<id>:<tab>" / "page:<mode>" — the `right=` URL value and the pref's. */
export function encodePane(target: PaneTarget): string {
  return target.kind === "note" ? `note:${target.id}:${target.tab}` : `page:${target.mode}`;
}

export function decodePane(text: string | null | undefined): PaneTarget | null {
  if (!text) return null;
  const [kind, first, ...rest] = text.split(":");
  if (kind === "page" && first && rest.length === 0) return { kind: "page", mode: first };
  if (kind === "note" && first) return { kind: "note", id: first, tab: rest.join(":") || "content" };
  return null;
}

export const samePane = (a: PaneTarget | null, b: PaneTarget | null): boolean =>
  !!a && !!b && encodePane(a) === encodePane(b);

/** One page twice, or one saved view twice, shows the same thing twice: neither
 *  pair may share the screen. The same note in two DIFFERENT views (text |
 *  whiteboard) is the point of the feature. A note's text on both sides is 並排:
 *  only the left has an editor, the right shows it rendered (SplitPane), so it
 *  is allowed. */
export function panesConflict(a: PaneTarget, b: PaneTarget): boolean {
  if (a.kind === "page" && b.kind === "page") return a.mode === b.mode;
  if (a.kind === "note" && b.kind === "note") return a.id === b.id && a.tab === b.tab && a.tab !== CONTENT_TAB;
  return false;
}

/** Which side of a window `width` wide a pointer at `x` is over, or null when
 *  it is outside. Used by every drag source, so there is one drop rule. */
export function dropSideAt(x: number, width: number): Side | null {
  if (!(width > 0) || x < 0 || x > width) return null;
  return x >= width / 2 ? "right" : "left";
}

/** What the right pane starts with when nothing was dragged over: the note
 *  last written (not the one open on the left), else today's day note, else
 *  null. `notes` are live content notes. */
export function defaultRightNote(
  notes: readonly (Parameters<typeof listsAsNote>[0] & { id: string; updated_at?: string | null })[],
  leftNoteId: string | null,
  todayNoteId: string | null,
): PaneTarget | null {
  const recent = notes.filter((n) => listsAsNote(n) && n.id !== leftNoteId).sort(byUpdatedDesc)[0];
  if (recent) return { kind: "note", id: recent.id, tab: "content" };
  if (todayNoteId && todayNoteId !== leftNoteId) return { kind: "note", id: todayNoteId, tab: "content" };
  return null;
}

// ── Ctrl/⌘ + click: open on the other side ──────────────────────────────────
// A link's click handler deep in an editor or a page does not see the mouse
// event, so the press that started the click is remembered for a moment.

const MOD_CLICK_MS = 600;
let modPressAt = -Infinity;
/** Call from a capture-phase pointerdown: remember whether Ctrl/⌘ was held. */
export function notePress(event: { ctrlKey: boolean; metaKey: boolean }, now: number): void {
  modPressAt = event.ctrlKey || event.metaKey ? now : -Infinity;
}
/** Whether the click being handled now was made with Ctrl/⌘ held. */
export function isModClick(now: number): boolean { return now - modPressAt < MOD_CLICK_MS; }

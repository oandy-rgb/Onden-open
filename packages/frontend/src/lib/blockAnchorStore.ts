import type { LinkBinding, NoteAnchor } from "@onden/contract";
import { PREFS, getPref, setPref } from "./prefs";

export type { LinkBinding, NoteAnchor };

/** Whether the server has paragraph anchors on (bootstrap `features.paragraph_anchors`, i.e. ONDEN_BLOCK_ANCHORS is not
 *  off): the 「本篇的段落」 panel and 「獨立出去／收回原文」 show only then. False until a bootstrap says so. */
let enabled = false;
export const blockAnchorsEnabled = (): boolean => enabled;
export function setBlockAnchorsEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  emit();
}

/** A bootstrap or meta payload's `features`: the one place the flag is set from the server (the whole bootstrap and the
 *  reopen's `?nodes=none` read both come through here). Also kept for this account, so a reopen that cannot reach the server
 *  starts from the last answer (restoreBlockAnchorsEnabled) instead of hiding the paragraphs panel for the session. */
export function applyServerFeatures(features: { paragraph_anchors?: boolean } | undefined): void {
  const on = features?.paragraph_anchors === true;
  setBlockAnchorsEnabled(on);
  setPref(PREFS.blockAnchorsSeen, on ? "1" : "0");
}

/** The boot from the local copy: the last answer the server gave this account (off when it never gave one). */
export function restoreBlockAnchorsEnabled(): void {
  setBlockAnchorsEnabled(getPref(PREFS.blockAnchorsSeen) === "1");
}

const EMPTY: readonly NoteAnchor[] = [];
let byNote = new Map<string, readonly NoteAnchor[]>();
/** note id → (link text → anchor id) */
let bindingsByNote = new Map<string, ReadonlyMap<string, string>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const l of listeners) l(); };

function group<T extends { note_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) { const list = out.get(r.note_id); if (list) list.push(r); else out.set(r.note_id, [r]); }
  return out;
}

/** `held` with the notes in `carried` replaced by `made` (without the list, everything is replaced: the local copy at a cold start). */
function replaceFor<V>(held: ReadonlyMap<string, V>, carried: readonly string[] | undefined, made: Map<string, V>): Map<string, V> {
  const next = carried ? new Map(held) : new Map<string, V>();
  for (const id of carried ?? []) next.delete(id);
  for (const [id, v] of made) next.set(id, v);
  return next;
}

const bindingMaps = (rows: readonly LinkBinding[]) =>
  new Map([...group(rows)].map(([id, list]) => [id, new Map(list.map((b) => [b.link_text, b.anchor_id]))] as const));

/** A bootstrap's anchors replace what is held for the notes it carried (`carriedNoteIds`; a slim bootstrap does not
 *  carry every held note). Without the list (the local copy at a cold start) they replace everything. */
export function replaceAllAnchors(rows: readonly NoteAnchor[] | undefined, carriedNoteIds?: readonly string[]): void {
  if (!rows) return;
  byNote = replaceFor(byNote, carriedNoteIds, group(rows));
  emit();
}

/** The same for the link bindings (they belong to the note the link is written in). */
export function replaceAllBindings(rows: readonly LinkBinding[] | undefined, carriedNoteIds?: readonly string[]): void {
  if (!rows) return;
  bindingsByNote = replaceFor(bindingsByNote, carriedNoteIds, bindingMaps(rows));
  emit();
}

/** What a sync delta did to the anchors: replaced for the notes it shipped, gone with the notes it deleted. */
export function applyAnchorsOfDelta(delta: {
  note_anchors?: { upsert: readonly NoteAnchor[]; replace_for: readonly string[] };
  note_link_bindings?: { upsert: readonly LinkBinding[]; replace_for: readonly string[] };
  nodes: { delete: readonly string[] };
}): void {
  const gone = delta.nodes.delete.filter((id) => byNote.has(id) || bindingsByNote.has(id));
  if (!delta.note_anchors && !delta.note_link_bindings && gone.length === 0) return;
  const { note_anchors: anchors, note_link_bindings: bindings } = delta;
  byNote = replaceFor(byNote, [...gone, ...(anchors?.replace_for ?? [])], group(anchors?.upsert ?? []));
  bindingsByNote = replaceFor(bindingsByNote, [...gone, ...(bindings?.replace_for ?? [])], bindingMaps(bindings?.upsert ?? []));
  emit();
}

/** What is held, as the sync brought it (lib/blockLinks reads these: the lookups by anchor id and by link text live there, in the code
 *  that is loaded on use, not in the app's first JS). */
export const heldAnchors = (): ReadonlyMap<string, readonly NoteAnchor[]> => byNote;
export const heldBindings = (): ReadonlyMap<string, ReadonlyMap<string, string>> => bindingsByNote;

export function anchorsOf(noteId: string): readonly NoteAnchor[] { return byNote.get(noteId) ?? EMPTY; }

/** A paragraph's identity as the Markdown readers take it: the anchor id and where the paragraph starts and ends. */
export type AnchorSpan = { id: string; from: number; to: number };

/** How much of a paragraph's first words must still be where the server said, for its anchor to be trusted on text
 *  the server has not measured (edited here, offline or not yet synced). An edit inside the paragraph keeps its start. */
const TRUSTED_PREFIX = 6;

/** The valid anchors of `noteId` as the parsers read them (@onden/markdown parseBlocks, anchoredBlocks, extractBlock…).
 *  The positions are the server's, measured on the text it holds: given `markdown` (the text the reader is about to parse),
 *  an anchor whose first words are not where the server said (the text moved on, or the anchors are not those of this
 *  text) is left out, so a stale position never names the wrong paragraph. Without `markdown` they are returned as held. */
export function anchorSpansOf(noteId: string, markdown?: string): AnchorSpan[] {
  const out: AnchorSpan[] = [];
  for (const a of byNote.get(noteId) ?? EMPTY) {
    if (a.status !== "valid" || a.from >= a.to) continue;
    if (markdown !== undefined) {
      if (a.from >= markdown.length || !a.quote) continue;
      const n = Math.min(TRUSTED_PREFIX, a.quote.length, a.to - a.from);
      if (markdown.slice(a.from, a.from + n) !== a.quote.slice(0, n)) continue;
    }
    out.push({ id: a.anchor_id, from: a.from, to: Math.min(a.to, markdown?.length ?? a.to) });
  }
  return out;
}

/** Changes whenever an anchor or a link binding does (useSyncExternalStore's snapshot: lib/blockLinks usePartLinkVersion). */
export function anchorsVersion(): number { return version; }

/** Re-render when anchors change (a screen subscribes; nothing in the boot path does). */
export function watchAnchors(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

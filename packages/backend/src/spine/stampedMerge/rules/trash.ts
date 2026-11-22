// A deletion meeting a change it had not seen (4.9). The delete takes effect; nobody's words are lost, and the person who
// wrote them is told where they went. "Had not seen" is the deleting write's `seen` (`seenOfRow` in a store: per origin the
// highest sequence number of that node's writes to the row the deleter held). It is used here for who to tell and what to
// hand back, never to decide what the merged data is, so a wrong claim can silence a notice but cannot lose a value.
import type { Saw, Stamp } from "../unit.js";

export type Deletion = { stamp: Stamp; seen: Saw };
export type Notice = { to: string; note: string; kind: "edit-kept-in-trash" | "created-under-deleted-parent" };

const hadSeen = (d: Deletion, w: Stamp): boolean => w.seq <= (d.seen[w.origin] ?? -1);
const byNote = (a: Notice, b: Notice) => (a.note + a.to + a.kind < b.note + b.to + b.kind ? -1 : 1);

/** One note in the trash, and the writes to it the deleter had not seen. The edit stays in the note (the fields merge on their own); the editor is told, unless that was the same person on another device. */
export function noticesForEditedDeletes(notes: readonly { id: string; deleted: Deletion | null; edits: readonly Stamp[] }[]): Notice[] {
  const out = new Map<string, Notice>();
  for (const n of notes) {
    if (!n.deleted) continue;
    for (const e of n.edits) {
      if (hadSeen(n.deleted, e) || e.author === null || e.author === n.deleted.stamp.author) continue;
      out.set(`${n.id}|${e.author}`, { to: e.author, note: n.id, kind: "edit-kept-in-trash" });
    }
  }
  return [...out.values()].sort(byNote);
}

/** A note as the 4.9 view reads it: `created` its creation, `placed` the write that put it under `parent` (a move; its creation when it was made there and never moved). */
export type TreeNote = { id: string; parent: string | null; created: Stamp; placed?: Stamp; deleted: Deletion | null };
export type TrashFix = { note: string; trashedWith: string };
/**
 * A live note under a deleted one: it got there by a write the deleter had not seen (its creation, or a move under that parent: the simulator's R4), or its
 * deletion would have taken it (the ordinary cascade writes every live note of the subtree it holds; a restore brings its ancestors back with it). So it goes to
 * the trash with that parent, as a VIEW, and comes back with it. Who is told is decided by `seen`, as everywhere in this file: the person whose write put it there
 * (its creation, else the move), when the deleter had not seen that write and is not the same person. `seen` names what the deleter held of the DELETED row
 * only, so it can claim a write the deleter never held (a node can hold a later write of an origin and not an earlier one); it silences a notice at most, it
 * never keeps a note out of the trash (the first version did, and the simulator found a note left live under a trashed parent: seed 3430408549).
 * A note further down goes with the nearest deleted ancestor too (`trashedWith`); its author is told on the same terms.
 */
export function trashOrphanedChildren(notes: readonly TreeNote[]): { fixes: TrashFix[]; notices: Notice[] } {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const fixes: TrashFix[] = [], notices: Notice[] = [];
  for (const n of [...notes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (n.deleted) continue;
    // the nearest deleted ancestor (a loop of parents is cut by 4.10 elsewhere: its notes are not followed twice)
    const seen = new Set<string>([n.id]);
    let p = n.parent === null ? undefined : byId.get(n.parent);
    while (p && !seen.has(p.id) && !p.deleted) { seen.add(p.id); p = p.parent === null ? undefined : byId.get(p.parent); }
    if (!p?.deleted || seen.has(p.id)) continue;
    fixes.push({ note: n.id, trashedWith: p.id });
    // told: the person whose write (its creation, else the move) put this note there, when the deleter had not seen that write
    const unseen = !hadSeen(p.deleted, n.created) ? n.created : n.placed && !hadSeen(p.deleted, n.placed) ? n.placed : null;
    const who = unseen?.author ?? null;
    if (who !== null && who !== p.deleted.stamp.author) notices.push({ to: who, note: n.id, kind: "created-under-deleted-parent" });
  }
  return { fixes, notices: notices.sort(byNote) };
}

export type FieldWrite = { field: string; stamp: Stamp; value: unknown };
export type RecoveryCopy = { to: string; row: string; fields: FieldWrite[]; notify: boolean };
/** A row deleted for good while another node wrote to it (a write the deleter had not seen): the row stays gone, and each author gets those fields back as a recovery copy. */
export function recoverLateEdits(rows: readonly { id: string; purged: Deletion | null; writes: readonly FieldWrite[] }[]): RecoveryCopy[] {
  const out: RecoveryCopy[] = [];
  for (const r of rows) {
    if (!r.purged) continue;
    const byAuthor = new Map<string, FieldWrite[]>();
    for (const w of r.writes) {
      if (hadSeen(r.purged, w.stamp) || w.stamp.author === null) continue;
      byAuthor.set(w.stamp.author, [...(byAuthor.get(w.stamp.author) ?? []), w]);
    }
    for (const [to, fields] of byAuthor) out.push({ to, row: r.id, fields: fields.sort((a, b) => (a.field < b.field ? -1 : 1)), notify: to !== r.purged.stamp.author });
  }
  return out.sort((a, b) => (a.row + a.to < b.row + b.to ? -1 : 1));
}

/** A row of another table that hangs on a note (an attribute, a tag applied to it, a pointer to or under it, its position on a board, a reference it holds). */
export type HangingRow = { table: string; row: string; on: string; created: Stamp };
export type Hanging = { table: string; row: string; on: string };
/**
 * Rule 4.9 for the rows that hang on a note, as a VIEW: a row made (or made again) on a note that was deleted for good by someone who had not seen that row. The row is not kept
 * (there is no note to hold it, the database refuses it); every node computes the same list from stamps it holds, and the row's maker is told, unless they are the deleter.
 * A row the deleter HAD seen is the ordinary cascade's and not this rule's. Nothing is written: a stamped delete made by each node on its own would be a write nobody made.
 */
export function rowsOnDeletedNotes(rows: readonly HangingRow[], deleted: ReadonlyMap<string, Deletion>): { hanging: Hanging[]; notices: Notice[] } {
  const hanging: Hanging[] = [], notices: Notice[] = [];
  for (const r of [...rows].sort((a, b) => (a.table + a.row + a.on < b.table + b.row + b.on ? -1 : 1))) {
    const d = deleted.get(r.on);
    if (!d || hadSeen(d, r.created)) continue;
    hanging.push({ table: r.table, row: r.row, on: r.on });
    if (r.created.author !== null && r.created.author !== d.stamp.author) notices.push({ to: r.created.author, note: r.on, kind: "created-under-deleted-parent" });
  }
  return { hanging, notices: notices.sort(byNote) };
}

// The rows the simulation keeps and the changes a person makes to them, written the way the real tables will be stamped
// (causal-stamps §4): notes (title, body, parent, trash, slug, publication), tags (name, parent, trash), saved views (owner, name),
// focus sessions, function references (config per key), permission changes. Also the views that turn a converged store into
// what the cross-row rules (spine/stampedMerge/rules) take.
import { type Json, type Stamp, type Unit, compareStamps, conflictsOf, winnerOf } from "../../../spine/stampedMerge/unit.js";
import { type Store, createRow, deleteRow, effectiveUnit, fieldsOf, jsonObjectOf, keyField, rowKeys, rowOf, seenOfRow, writeField } from "../../../spine/stampedMerge/store.js";
import type { Deletion, FieldWrite, TreeNote } from "../../../spine/stampedMerge/rules/trash.js";
import type { FocusSession } from "../../../spine/stampedMerge/rules/focus.js";
import type { ParentLink } from "../../../spine/stampedMerge/rules/moveCycle.js";
import type { FunctionRefRow } from "../../../spine/stampedMerge/rules/functionRefs.js";
import type { PermissionChange, Permission } from "../../../spine/stampedMerge/rules/permission.js";
import type { SlugItem } from "../../../spine/stampedMerge/rules/names.js";
import type { SimNode, StampedWorld } from "./world.js";

export const NOTE = "note", TAG = "tag", VIEW = "view", FOCUS = "focus", REF = "ref", PERM = "perm";
export const BASE_BODY = "第一行\n第二行\n第三行\n";

export type OpKind =
  | "note.new" | "note.derived" | "note.title" | "note.body" | "note.move" | "note.trash" | "note.restore" | "note.purge" | "note.slug" | "note.publish"
  | "tag.new" | "tag.rename" | "tag.trash" | "view.new" | "view.rename" | "focus.start" | "focus.end" | "ref.new" | "ref.config" | "perm.set" | "note.edit-as" | "note.system" | "note.genesis";
/** A step is data: every random choice is already a number in 0..1, so a list can be replayed and cut down. */
export type Step = { t: "op"; node: number; kind: OpKind; p: [number, number, number] } | { t: "deliver"; n: number } | { t: "tick"; ms: number } | { t: "gossip"; a: number; b: number };

const at = <T,>(xs: readonly T[], f: number): T => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]!;
export const NOTE_POOL = ["a", "b", "c", "d", "e"], TAG_POOL = ["x", "y", "z"], OWNER_POOL = ["o1", "o2"], NAME_POOL = ["甲", "乙", "丙"], SLUG_POOL = ["s1", "s2"];
export const ACTOR_POOL = ["u0", "u1", "u2", "u3"];
/** Rows every node holds from before stamps existed, and the values nodes may hold for them (one of the three, per node: two nodes disagree, one agrees with another). */
export const GENESIS_ROWS = ["g1", "g2"], GENESIS_VALUES = ["from a backup", "from here", "same everywhere"];

const live = (store: Store, table: string): string[] => rowKeys(store, table).map((r) => r.row);
const winnerValue = (store: Store, table: string, row: string, field: string): Json | undefined => { const u = effectiveUnit(store, { table, row, field }); return u && !u[0]!.deleted ? u[0]!.value : undefined; };
const isTrashed = (store: Store, table: string, row: string): boolean => !!effectiveUnit(store, { table, row, field: "trashed" })?.[0]?.deleted;
let uniq = 0;
export const resetUnique = (): void => { uniq = 0; };
const fresh = (n: SimNode, what: string) => `${what}-${n.id}-${++uniq}`;

/** Make a body edit from the text the node holds: every edit adds a line that is unique to it, so "whose words are these" is exact. */
function editBody(text: string, who: string, p: number, q: number): string {
  const lines = text.split("\n").filter((l) => l !== "");
  const i = Math.floor(p * (lines.length + 1));
  if (q < 0.7 || lines.length < 3) lines.splice(i, 0, `${who}加的句子${++uniq}`);
  else lines.splice(Math.floor(p * lines.length), 1, `${who}改寫${++uniq}`);
  return lines.join("\n") + "\n";
}

export function applyStampedOp(w: StampedWorld, n: SimNode, kind: OpKind, [p, q, r]: [number, number, number]): void {
  const s = n.store;
  const notes = live(s, NOTE), tags = live(s, TAG), views = live(s, VIEW), focuses = live(s, FOCUS), refs = live(s, REF);
  const L = (change: (store: Store, stamp: Stamp) => Store) => w.local(n, kind, change);
  switch (kind) {
    case "note.new": { const id = fresh(n, "note"); L((st, sp) => createRow(st, { table: NOTE, row: id }, sp, { title: `${n.id}的筆記${uniq}`, body: BASE_BODY, parent: notes.length && q < 0.5 ? at(notes, r) : null })); return; }
    case "note.derived": { const id = at(NOTE_POOL, p);  L((st, sp) => createRow(st, { table: NOTE, row: id }, sp, { title: `固定${id}`, body: BASE_BODY, parent: null })); return; }
    case "note.genesis": w.seedGenesis(n, { table: NOTE, row: at(GENESIS_ROWS, p), field: "title" }, at(GENESIS_VALUES, q)); return;
    case "note.system": if (notes.length) {
      const row = at(notes, p), held = effectiveUnit(s, { table: NOTE, row, field: "title" });
      if (held && conflictsOf(held).length > 0) w.systemBlocked++; // the system must leave this unit to a person
      L((st, sp) => writeField(st, { table: NOTE, row, field: "title" }, sp, { value: `系統${n.id}${++uniq}` }, "system"));
    } return;
    case "note.title": if (notes.length) L((st, sp) => writeField(st, { table: NOTE, row: at(notes, p), field: "title" }, sp, { value: q < 0.4 ? at(NAME_POOL, r) : `${n.id}的標題${++uniq}` })); return;
    case "note.body": if (notes.length) { const row = at(notes, p); const cur = winnerValue(s, NOTE, row, "body"); L((st, sp) => writeField(st, { table: NOTE, row, field: "body" }, sp, { value: editBody(String(cur ?? BASE_BODY), n.id, q, r) })); } return;
    case "note.move": if (notes.length) { const row = at(notes, p); const to = r < 0.2 ? null : at(notes, q); if (to === row) return; const from = winnerValue(s, NOTE, row, "parent") ?? null; L((st, sp) => writeField(st, { table: NOTE, row, field: "parent" }, sp, { value: to, meta: { from } })); } return;
    case "note.trash": if (notes.length) { const row = at(notes, p); L((st, sp) => writeField(st, { table: NOTE, row, field: "trashed" }, sp, { deleted: true, meta: { seen: seenOfRow(st, NOTE, row) } })); } return;
    case "note.restore": if (notes.length) { const row = at(notes, p); if (isTrashed(s, NOTE, row)) L((st, sp) => writeField(st, { table: NOTE, row, field: "trashed" }, sp, { value: false })); } return;
    case "note.purge": if (notes.length) { const row = at(notes, p); L((st, sp) => deleteRow(st, { table: NOTE, row }, sp, { seen: seenOfRow(st, NOTE, row) })); } return;
    case "note.slug": if (notes.length) L((st, sp) => writeField(st, { table: NOTE, row: at(notes, p), field: "slug" }, sp, { value: at(SLUG_POOL, q) })); return;
    case "note.publish": if (notes.length) L((st, sp) => writeField(st, { table: NOTE, row: at(notes, p), field: "published" }, sp, { value: true })); return;
    case "note.edit-as": if (notes.length) L((st, sp) => writeField(st, { table: NOTE, row: at(notes, p), field: "title" }, sp, { value: `${n.author}@${sp.wall}` })); return;
    case "tag.new": { const id = fresh(n, "tag"); L((st, sp) => createRow(st, { table: TAG, row: id }, sp, { name: at(NAME_POOL.slice(0, 2), p), parent: tags.length && q < 0.4 ? at(TAG_POOL.map((x) => x), r) : "" })); return; }
    case "tag.rename": if (tags.length) L((st, sp) => writeField(st, { table: TAG, row: at(tags, p), field: "name" }, sp, { value: at(NAME_POOL.slice(0, 2), q) })); return;
    case "tag.trash": if (tags.length) { const row = at(tags, p); L((st, sp) => writeField(st, { table: TAG, row, field: "trashed" }, sp, { deleted: true })); } return;
    case "view.new": { const id = fresh(n, "view"); L((st, sp) => createRow(st, { table: VIEW, row: id }, sp, { owner: at(OWNER_POOL, p), name: at(NAME_POOL.slice(0, 2), q) })); return; }
    case "view.rename": if (views.length) L((st, sp) => writeField(st, { table: VIEW, row: at(views, p), field: "name" }, sp, { value: at(NAME_POOL.slice(0, 2), q) })); return;
    case "focus.start": { const id = fresh(n, "focus"); const startedAt = w.physical(n); L((st, sp) => createRow(st, { table: FOCUS, row: id }, sp, { actor: at(ACTOR_POOL.slice(0, 2), p), startedAt, endedAt: null })); return; }
    case "focus.end": if (focuses.length) { const row = at(focuses, p); const endedAt = w.physical(n); L((st, sp) => writeField(st, { table: FOCUS, row, field: "endedAt" }, sp, { value: endedAt })); } return;
    case "ref.new": { const id = fresh(n, "ref"); L((st, sp) => createRow(st, { table: REF, row: id }, sp, { holder: at(["h1", "h2"], p), fn: "fn", instance: at(["i1", "i2"], q) })); return; }
    case "ref.config": if (refs.length) L((st, sp) => writeField(st, { table: REF, row: at(refs, p), field: keyField(at(["k1", "k2", "k3"], q)) }, sp, r < 0.15 ? { deleted: true } : { value: `${n.id}-${++uniq}` })); return;
    case "perm.set": { const id = fresh(n, "perm"); const permission: Permission = at(["edit", "none", "view", "edit"] as const, q); L((st, sp) => createRow(st, { table: PERM, row: id }, sp, { actor: at(ACTOR_POOL, p), permission })); return; }
  }
}

// ── Views over a converged store ─────────────────────────────────────────────────────────────────────────
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");
/** When a row was made: the oldest write to its `*` (heads can hold several if two nodes made the same id). */
export function createdOf(s: Store, table: string, row: string): Stamp {
  const star = rowOf(s, table, row).star;
  return [...(star ?? [])].map((c) => c.stamp).sort(compareStamps)[0]!;
}
const deletionOf = (u: Unit | undefined): Deletion | null => {
  const win = u?.[0];
  if (!win || !win.deleted) return null;
  return { stamp: win.stamp, seen: ((win.meta as { seen?: Record<string, number> } | undefined)?.seen) ?? {} };
};
const fieldWrites = (s: Store, table: string, row: string, fields: string[]): FieldWrite[] =>
  fields.flatMap((field) => (effectiveUnit(s, { table, row, field }) ?? []).filter((c) => !c.deleted).map((c) => ({ field, stamp: c.stamp, value: c.value })));

export const tagsOf = (s: Store) => live(s, TAG).filter((id) => rowOf(s, TAG, id).exists && !isTrashed(s, TAG, id))
  .map((id) => ({ id, parent: str(winnerValue(s, TAG, id, "parent")) || null, name: str(winnerValue(s, TAG, id, "name")), created: createdOf(s, TAG, id) }));
export const viewsOf = (s: Store) => live(s, VIEW).filter((id) => rowOf(s, VIEW, id).exists)
  .map((id) => ({ id, owner: str(winnerValue(s, VIEW, id, "owner")), name: str(winnerValue(s, VIEW, id, "name")), created: createdOf(s, VIEW, id) }));
export const slugsOf = (s: Store): SlugItem[] => live(s, NOTE).filter((id) => rowOf(s, NOTE, id).exists && winnerValue(s, NOTE, id, "slug") !== undefined)
  .map((id) => ({ id, slug: str(winnerValue(s, NOTE, id, "slug")), created: createdOf(s, NOTE, id), published: winnerValue(s, NOTE, id, "published") === true ? effectiveUnit(s, { table: NOTE, row: id, field: "published" })![0]!.stamp : null }));
export const focusOf = (s: Store): FocusSession[] => live(s, FOCUS).filter((id) => rowOf(s, FOCUS, id).exists)
  .map((id) => ({ id, actor: str(winnerValue(s, FOCUS, id, "actor")), startedAt: Number(winnerValue(s, FOCUS, id, "startedAt")), endedAt: (winnerValue(s, FOCUS, id, "endedAt") ?? null) as number | null }));
export const treeOf = (s: Store): TreeNote[] => live(s, NOTE).filter((id) => rowOf(s, NOTE, id).exists)
  .map((id) => ({ id, parent: (winnerValue(s, NOTE, id, "parent") ?? null) as string | null, created: createdOf(s, NOTE, id), deleted: deletionOf(effectiveUnit(s, { table: NOTE, row: id, field: "trashed" })) }));
export const editsOf = (s: Store) => live(s, NOTE).filter((id) => rowOf(s, NOTE, id).exists).map((id) => ({
  id, deleted: deletionOf(effectiveUnit(s, { table: NOTE, row: id, field: "trashed" })),
  edits: fieldWrites(s, NOTE, id, ["title", "body"]).map((w) => w.stamp),
}));
export const purgedOf = (s: Store) => live(s, NOTE).map((id) => {
  const star = rowOf(s, NOTE, id).star;
  const win = star?.[0];
  return { id, purged: win?.deleted ? { stamp: win.stamp, seen: ((win.meta as { seen?: Record<string, number> } | undefined)?.seen) ?? {} } : null, writes: fieldWrites(s, NOTE, id, fieldsOf(s, NOTE, id)) };
});
export const linksOf = (s: Store): ParentLink[] => live(s, NOTE).filter((id) => rowOf(s, NOTE, id).exists).map((id) => {
  const u = effectiveUnit(s, { table: NOTE, row: id, field: "parent" })!;
  const win = winnerOf(u);
  const from = (win.meta as { from?: string | null } | undefined)?.from;
  return { note: id, parent: (win.value ?? null) as string | null, ...(from === undefined ? {} : { from }), stamp: win.stamp };
});
export const refsOf = (s: Store): FunctionRefRow[] => live(s, REF).filter((id) => rowOf(s, REF, id).exists).map((id) => ({
  id, holder: str(winnerValue(s, REF, id, "holder")), fn: str(winnerValue(s, REF, id, "fn")), instance: str(winnerValue(s, REF, id, "instance")), created: createdOf(s, REF, id),
  config: Object.fromEntries(fieldsOf(s, REF, id).filter((f) => f.startsWith("key:")).map((f) => [f, effectiveUnit(s, { table: REF, row: id, field: f })!])),
}));
export const permissionsOf = (s: Store): PermissionChange[] => live(s, PERM).map((id) => ({
  actor: str(winnerValue(s, PERM, id, "actor")), permission: str(winnerValue(s, PERM, id, "permission")) as Permission, stamp: createdOf(s, PERM, id),
}));
export { conflictsOf, jsonObjectOf };

// Random multi-step undo / history restore, through the real routes.
//
// A generated sequence of operations (create, edit body, rename, move, tag /
// untag, set / clear attribute, delete, undelete, edge create / delete) runs
// against the real app and, in step, against a small reference model. Then a
// random subset of the recorded events is restored (POST /api/events/:id/restore)
// in a random order. After every restore attempt:
//
//  - never a 500, never an unnamed refusal code;
//  - a refusal changes nothing (state and event log are exactly as before);
//  - a success is a real change (no "200, nothing happened"), and equals the
//    model's "this event's own changes taken back" on top of the current state;
//  - an event no later (surviving) event depends on MUST be restorable;
//  - restoring the same event again is refused and changes nothing.
// At the end the state is also compared with the original sequence replayed
// WITHOUT the undone events (when nothing depended on them).
//
// Dependence is slot based: every operation reads and writes named slots
// (`title:3`, `tag:1:0`, `live:2` …); event E depends on a later surviving
// event F when E's writes meet F's reads or writes. Body edits are merged line
// by line, so two edits depend on each other only when they touch the same or
// neighbouring gaps between lines (every line is unique, so the model can say
// exactly which). A dependent event may be refused, or restored exactly.
//
// Known issues. #22 (empty inverse patch treated as "unchanged", data-integrity.md)
// is fixed in PR fix/a2-structure-import-backup: the it.fails below names it and
// the random run leaves its trigger (a lone surrogate in a body line) out;
// HISTORY_PROPS_KNOWN=1 puts it back. #20 (tag
// rename undone onto a taken name) does NOT reproduce on this checkout:
// eventRestore/tags.ts already answers state_conflict, so it is a plain test.
// #21 (backup restore job event id) is not an event restore and out of reach.
// F1 (an undo that changes nothing answered 200) is fixed: it is refused as
// already_in_state, in the random run and in the F1 case below.
//
// Run count and seed: PROPS_RUNS (default 20 here: every run is ~30 database
// writes) and PROPS_SEED, like the other property tests; a failure prints the
// seed, the shrunk operations and the step-by-step trace.
//
//   PROPS_SEED=123 PROPS_RUNS=300 npx vitest run src/test/properties/historyRestore.property.integration.test.ts
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getWorkspaceId, pool, q } from "../../db.js";
import { joinDefaultSpace } from "../helpers/spaceFixtures.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync, PROPS_SEED } from "../helpers/propsConfig.js";
import { seedQ } from "../helpers/seedQ.js";
import { slugForTitle } from "../../services/nodes.js";

vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../../app.js");

const isTestDb = isTestDatabase();
/** Put the known bugs' triggers back into the random run. */
const INCLUDE_KNOWN = process.env.HISTORY_PROPS_KNOWN === "1";
/** Every run is dozens of writes; stay small unless the caller asks for more. */
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 20;

const FIXED_PR = "fix/a2-structure-import-backup";

// ── HTTP ─────────────────────────────────────────────────────────────────────

type Reply = { status: number; body: any };
async function call(path: string, method = "GET", json?: unknown): Promise<Reply> {
  const res = await app.request(path, {
    method,
    headers: { origin: "http://localhost", ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

const REFUSALS: Record<string, number> = {
  patch_conflict: 409, state_conflict: 409, history_incomplete: 409, already_in_state: 409,
  external: 409, reserved_tag: 409, target_gone: 410, irreversible: 410, unsupported: 422,
};
const isRefusal = (r: Reply) => typeof r.body?.error === "string" && REFUSALS[r.body.error] === r.status;
const describeReply = (r: Reply) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

// ── Model ────────────────────────────────────────────────────────────────────

type NoteM = {
  title: string;
  parent: number | null;
  live: boolean;
  /** Every line this note ever had → its position in the all-ever order. */
  pos: Record<string, number>;
  liveLines: string[];
  tags: number[];
  attrs: Record<string, string>;
  /** The delete (token) that trashed it, while it is deleted. */
  deletedBy: number | null;
};
type Model = {
  notes: Record<number, NoteM>;
  tagNames: Record<number, string>;
  edges: Record<number, { src: number; dst: number }>;
  token: number;
  /** token → the note that was deleted explicitly (the delete's root). */
  rootOf: Record<number, number>;
};

const emptyModel = (): Model => ({ notes: {}, tagNames: {}, edges: {}, token: 0, rootOf: {} });
const clone = (m: Model): Model => structuredClone(m);
const liveNotes = (m: Model) => Object.keys(m.notes).map(Number).filter((k) => m.notes[k]!.live);

const ATTR_KEYS = ["k1", "k2"];
const LONE = "\ud800";
/** What the database holds for a body: a lone surrogate cannot be stored. */
const stored = (s: string) => s.replace(/[\ud800-\udfff]/g, "�");
const bodyOf = (n: NoteM) =>
  n.liveLines.length ? `${[...n.liveLines].sort((a, b) => n.pos[a]! - n.pos[b]!).join("\n")}\n` : "";

function subtreeOf(m: Model, root: number): number[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const k of liveNotes(m)) if (m.notes[k]!.parent === out[i] && !out.includes(k)) out.push(k);
  }
  return out;
}
/** `k` and every ancestor of it, nearest first. */
function chainOf(m: Model, k: number | null): number[] {
  const out: number[] = [];
  for (let at = k; at !== null && !out.includes(at); at = m.notes[at]?.parent ?? null) out.push(at);
  return out;
}

// ── Operations ───────────────────────────────────────────────────────────────

type Op =
  | { t: "createNote"; note: number; parent: number | null; title: string; lines: string[] }
  | { t: "editBody"; note: number; after: string | null; inserted: string[]; removed: string[] }
  | { t: "rename"; note: number; title: string }
  | { t: "move"; note: number; parent: number | null }
  | { t: "tagApply" | "tagRemove"; note: number; tag: number }
  | { t: "tagRename"; tag: number; name: string }
  | { t: "createTag"; tag: number; name: string }
  | { t: "attrSet"; note: number; key: string; value: string }
  | { t: "attrClear"; note: number; key: string }
  | { t: "delete"; note: number }
  | { t: "undelete"; note: number }
  | { t: "edgeCreate"; edge: number; src: number; dst: number }
  | { t: "edgeDelete"; edge: number };

/** Position for a new line right after `after` (null = at the top). */
function posAfter(n: NoteM, after: string | null): number {
  const lo = after === null ? 0 : n.pos[after]!;
  const above = Object.values(n.pos).filter((p) => p > lo);
  const hi = above.length ? Math.min(...above) : lo + 1024;
  return (lo + hi) / 2;
}

/** The operation's effect on the model; false when its precondition fails
 *  (only possible in a replay without some events). */
function applyOp(m: Model, op: Op): boolean {
  switch (op.t) {
    case "createNote": {
      if (m.notes[op.note]) return false;
      if (op.parent !== null && !m.notes[op.parent]?.live) return false;
      const pos: Record<string, number> = {};
      op.lines.forEach((l, i) => { pos[l] = (i + 1) * 1024; });
      m.notes[op.note] = { title: op.title, parent: op.parent, live: true, pos, liveLines: [...op.lines], tags: [], attrs: {}, deletedBy: null };
      return true;
    }
    case "editBody": {
      const n = m.notes[op.note];
      if (!n?.live) return false;
      if (!op.removed.every((l) => n.liveLines.includes(l))) return false;
      if (op.after !== null && !n.liveLines.includes(op.after)) return false;
      let at = op.after;
      for (const l of op.inserted) { n.pos[l] = posAfter(n, at); at = l; }
      n.liveLines = [...n.liveLines.filter((l) => !op.removed.includes(l)), ...op.inserted];
      return true;
    }
    case "rename": {
      const n = m.notes[op.note];
      if (!n?.live) return false;
      n.title = op.title;
      return true;
    }
    case "move": {
      const n = m.notes[op.note];
      if (!n?.live || n.parent === op.parent) return false;
      if (op.parent !== null && (!m.notes[op.parent]?.live || subtreeOf(m, op.note).includes(op.parent))) return false;
      n.parent = op.parent;
      return true;
    }
    case "tagApply": case "tagRemove": {
      const n = m.notes[op.note];
      if (!n?.live || m.tagNames[op.tag] === undefined) return false;
      const has = n.tags.includes(op.tag);
      if (has === (op.t === "tagApply")) return false;
      n.tags = op.t === "tagApply" ? [...n.tags, op.tag].sort() : n.tags.filter((t) => t !== op.tag);
      return true;
    }
    case "tagRename": {
      if (m.tagNames[op.tag] === undefined || m.tagNames[op.tag] === op.name) return false;
      if (Object.values(m.tagNames).includes(op.name)) return false;
      m.tagNames[op.tag] = op.name;
      return true;
    }
    case "createTag": {
      if (m.tagNames[op.tag] !== undefined || Object.values(m.tagNames).includes(op.name)) return false;
      m.tagNames[op.tag] = op.name;
      return true;
    }
    case "attrSet": {
      const n = m.notes[op.note];
      if (!n?.live || n.attrs[op.key] === op.value) return false;
      n.attrs[op.key] = op.value;
      return true;
    }
    case "attrClear": {
      const n = m.notes[op.note];
      if (!n?.live || n.attrs[op.key] === undefined) return false;
      delete n.attrs[op.key];
      return true;
    }
    case "delete": return trash(m, op.note) !== null;
    case "undelete": {
      const n = m.notes[op.note];
      if (!n || n.live || n.deletedBy === null || m.rootOf[n.deletedBy] !== op.note) return false;
      return revive(m, op.note) !== null;
    }
    case "edgeCreate": {
      if (!m.notes[op.src]?.live || !m.notes[op.dst]?.live) return false;
      m.edges[op.edge] = { src: op.src, dst: op.dst };
      return true;
    }
    case "edgeDelete": {
      // the route needs write access to the source, which a deleted note has not
      if (!m.edges[op.edge] || !m.notes[m.edges[op.edge]!.src]?.live) return false;
      delete m.edges[op.edge];
      return true;
    }
  }
}

/** Delete a live note with its live subtree; the notes it took, or null. */
function trash(m: Model, note: number): number[] | null {
  if (!m.notes[note]?.live) return null;
  const taken = subtreeOf(m, note);
  const token = ++m.token;
  m.rootOf[token] = note;
  for (const k of taken) { m.notes[k]!.live = false; m.notes[k]!.deletedBy = token; }
  return taken;
}

/** Bring a deleted note back with what was deleted with it and the deleted
 *  notes above it (services/nodeTrash.ts restoreLive); the notes revived. */
function revive(m: Model, note: number): number[] | null {
  const n = m.notes[note];
  if (!n || n.live || n.deletedBy === null) return null;
  const token = n.deletedBy;
  const back: number[] = [];
  for (const a of chainOf(m, n.parent)) {
    if (!m.notes[a]!.live) back.push(a);
  }
  for (const k of Object.keys(m.notes).map(Number)) {
    if (m.notes[k]!.deletedBy === token && !m.notes[k]!.live) back.push(k);
  }
  for (const k of back) { m.notes[k]!.live = true; m.notes[k]!.deletedBy = null; }
  return back;
}

// ── Reads / writes (dependence) ──────────────────────────────────────────────

type Slots = { reads: string[]; writes: string[] };
const live = (k: number | null) => (k === null ? [] : [`live:${k}`]);

/** Slots of `op`, computed on the model BEFORE it ran. */
function slotsOf(op: Op, m: Model): Slots {
  switch (op.t) {
    case "createNote": return { reads: live(op.parent), writes: [`live:${op.note}`] };
    case "editBody": return { reads: live(op.note), writes: [] };
    case "rename": return { reads: live(op.note), writes: [`title:${op.note}`] };
    case "move": {
      const old = m.notes[op.note]!.parent;
      const chain = [...chainOf(m, old), ...chainOf(m, op.parent)].map((k) => `parent:${k}`);
      return { reads: [...live(op.note), ...live(old), ...live(op.parent), ...chain], writes: [`parent:${op.note}`] };
    }
    case "tagApply": case "tagRemove": return { reads: live(op.note), writes: [`tag:${op.note}:${op.tag}`] };
    case "tagRename": return { reads: [], writes: [`tagname:${op.tag}`, `tn:${m.tagNames[op.tag]}`, `tn:${op.name}`] };
    case "createTag": return { reads: [], writes: [`tagname:${op.tag}`, `tn:${op.name}`] };
    case "attrSet": case "attrClear": return { reads: live(op.note), writes: [`attr:${op.note}:${op.key}`] };
    case "delete": {
      const taken = subtreeOf(m, op.note);
      const above = chainOf(m, m.notes[op.note]!.parent);
      return { reads: above.flatMap(live), writes: taken.flatMap(live) };
    }
    case "undelete": {
      const probe = clone(m);
      const back = revive(probe, op.note) ?? [];
      return { reads: [], writes: back.flatMap(live) };
    }
    case "edgeCreate": return { reads: [...live(op.src), ...live(op.dst)], writes: [`edge:${op.edge}`] };
    case "edgeDelete": return { reads: [], writes: [`edge:${op.edge}`] };
  }
}

// ── A recorded operation ─────────────────────────────────────────────────────

type Done = {
  idx: number;
  op: Op;
  label: string;
  eventId: string;
  eventType: string;
  slots: Slots;
  /** The model's state after taking this event's own changes back, on top of
   *  `m` (the current state); null when that is impossible (target dead). */
  inverse: ((m: Model) => Model | null) | null;
  /** Events the restore API has no inverse for (edges, tag creation). */
  unsupported: boolean;
  /** Body edits: the gaps between lines the edit touched (filled in at the end). */
  body: { note: number; inserted: string[]; removed: string[]; after: string | null } | null;
};

/** What taking `op` back means for the model. Scalar slots go back to the value
 *  the op overwrote; body edits give back the lines they took and take back the
 *  lines they added; structural events delete / bring back notes. */
function inverseOf(op: Op, before: Model): Done["inverse"] {
  const need = (m: Model, k: number): NoteM | null => (m.notes[k]?.live ? m.notes[k]! : null);
  switch (op.t) {
    case "createNote": return (m) => { const c = clone(m); return trash(c, op.note) ? c : null; };
    case "undelete": return (m) => { const c = clone(m); return trash(c, op.note) ? c : null; };
    case "delete": return (m) => { const c = clone(m); return revive(c, op.note) ? c : null; };
    case "editBody": return (m) => {
      const c = clone(m); const n = need(c, op.note);
      if (!n) return null;
      n.liveLines = [...n.liveLines.filter((l) => !op.inserted.includes(l)), ...op.removed.filter((l) => !n.liveLines.includes(l))];
      return c;
    };
    case "rename": { const was = before.notes[op.note]!.title; return (m) => { const c = clone(m); const n = need(c, op.note); if (!n) return null; n.title = was; return c; }; }
    case "move": { const was = before.notes[op.note]!.parent; return (m) => { const c = clone(m); const n = need(c, op.note); if (!n) return null; n.parent = was; return c; }; }
    case "tagApply": case "tagRemove": {
      const had = before.notes[op.note]!.tags.includes(op.tag);
      return (m) => {
        const c = clone(m); const n = c.notes[op.note];
        if (!n) return null;
        n.tags = had ? [...new Set([...n.tags, op.tag])].sort() : n.tags.filter((t) => t !== op.tag);
        return c;
      };
    }
    case "tagRename": { const was = before.tagNames[op.tag]!; return (m) => { const c = clone(m); c.tagNames[op.tag] = was; return c; }; }
    case "attrSet": case "attrClear": {
      const was = before.notes[op.note]!.attrs[op.key];
      return (m) => {
        const c = clone(m); const n = c.notes[op.note];
        if (!n) return null;
        if (was === undefined) delete n.attrs[op.key]; else n.attrs[op.key] = was;
        return c;
      };
    }
    case "createTag": case "edgeCreate": case "edgeDelete": return null;
  }
}

// ── Normalized state (model and database compared in this shape) ─────────────

type NoteView = { live: boolean; title: string; parent: number | null; body: string; tags: number[]; attrs: string[] };
type View = { notes: Record<number, NoteView>; tagNames: Record<number, string>; edges: string[] };

function viewOf(m: Model, noteKeys: number[], tagKeys: number[], looseBody: number | null = null): View {
  const notes: Record<number, NoteView> = {};
  for (const k of noteKeys) {
    const n = m.notes[k];
    if (!n) { notes[k] = { live: false, title: "", parent: null, body: "", tags: [], attrs: [] }; continue; }
    const lines = n.liveLines.map(stored);
    notes[k] = {
      live: n.live, title: n.title, parent: n.parent,
      body: k === looseBody ? [...lines].sort().join("\n") : bodyOf({ ...n, liveLines: lines, pos: Object.fromEntries(n.liveLines.map((l) => [stored(l), n.pos[l]!])) }),
      tags: [...n.tags].sort(), attrs: Object.entries(n.attrs).map(([key, v]) => `${key}=${v}`).sort(),
    };
  }
  const tagNames: Record<number, string> = {};
  for (const t of tagKeys) tagNames[t] = m.tagNames[t]!;
  return { notes, tagNames, edges: Object.values(m.edges).map((e) => `${e.src}>${e.dst}`).sort() };
}

// ── Test database fixture ────────────────────────────────────────────────────

describe.skipIf(!isTestDb)("history restore: random multi-step undo (model based)", () => {
  const stamp = Date.now();
  let runSerial = 0;
  let workspaceId = "";
  let spaceId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    workspaceId = await getWorkspaceId();
    await q(`INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'System','agent','system') ON CONFLICT(workspace_id,external_id) DO NOTHING`, [workspaceId]);
    const systemId = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId])).rows[0]!.id;
    await joinDefaultSpace(workspaceId, systemId, "admin");
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [workspaceId, `HP${stamp}%`]);
    await pool.end();
  });

  // ── One world: the real notes/tags of a run, its model, its trace ──────────

  class World {
    readonly prefix = `HP${stamp}r${runSerial++}-`;
    noteIds = new Map<number, string>();
    tagIds = new Map<number, string>();
    edgeIds = new Map<number, string>();
    model = emptyModel();
    ops: Done[] = [];
    seedNames: Record<number, string> = {};
    /** Tags and notes that exist before the first operation (not undoable). */
    seedModel = emptyModel();
    trace: string[] = [];

    log(line: string) { this.trace.push(line); }
    fail(message: string): never {
      throw new Error(`${message}\n--- trace ---\n${this.trace.join("\n")}`);
    }

    async lastEventId(): Promise<string> {
      return (await q<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.id;
    }
    /** scan 15 M10: a note-update restore event is a version like any save: it always carries the title, and body_hash when the text or title moved. */
    async expectVersionShape(marker: string, tag: string): Promise<void> {
      const evs = (await q<{ id: string; title: string | null; body_hash: string | null; now_title: string | null; title_moved: boolean; text_moved: boolean }>(
        `SELECT e.id::text, e.payload->>'title' AS title, e.payload->>'body_hash' AS body_hash, n.title AS now_title,
                (e.tx_meta->'prev_field_values' ? 'title') AS title_moved, COALESCE(e.tx_meta->>'inverse_patch', '') <> '' AS text_moved
           FROM domain_events e JOIN content_nodes n ON n.id::text = e.target_id
          WHERE e.workspace_id = $1 AND e.id > $2::bigint AND e.event_type = 'NODE_UPDATED' AND n.node_type = 'content'`,
        [workspaceId, marker])).rows;
      for (const ev of evs) {
        if (ev.title !== ev.now_title) this.fail(`${tag}: restore event ${ev.id} carries title ${JSON.stringify(ev.title)}, note is ${JSON.stringify(ev.now_title)}`);
        if ((ev.title_moved || ev.text_moved) && !ev.body_hash) this.fail(`${tag}: restore event ${ev.id} moved the title or text but has no body_hash`);
      }
    }
    async eventCountSince(marker: string): Promise<number> {
      return (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint`, [workspaceId, marker])).rows[0]!.n;
    }

    async seedTags(): Promise<void> {
      for (let t = 0; t < 2; t++) {
        const name = INCLUDE_KNOWN ? `${this.prefix}p${"ab"[t]}` : `${this.prefix}t${t}`;
        const r = await call("/api/tags", "POST", { name });
        if (r.status !== 201) this.fail(`seed tag failed: ${describeReply(r)}`);
        this.tagIds.set(t, r.body.id);
        this.model.tagNames[t] = name;
        this.seedNames[t] = name;
      }
    }

    async seedNotes(): Promise<void> {
      // Three notes to work on from the first step: 100, its child 101, and 102.
      for (const [note, parent] of [[100, null], [101, 100], [102, null]] as const) {
        const op: Op = { t: "createNote", note, parent, title: `s${note}`, lines: [`S${note}.0`, `S${note}.1`, `S${note}.2`] };
        const r = await this.send(op);
        if (r.status !== 201) this.fail(`seed note failed: ${describeReply(r)}`);
        applyOp(this.model, op);
      }
      this.seedModel = clone(this.model);
    }

    // ── Choosing an operation from a selector, against the current model ─────

    choose(sel: Sel, idx: number): Op | null {
      const m = this.model;
      const pick = <T,>(xs: T[], i: number): T | undefined => (xs.length ? xs[i % xs.length] : undefined);
      const lives = liveNotes(m);
      const line = (j: number) => `L${idx}.${j}${INCLUDE_KNOWN && sel.c % 4 === 0 && j === 0 ? LONE : ""}`;
      switch (sel.kind) {
        case "createNote": {
          if (Object.keys(m.notes).length >= 6) return null;
          const parent = sel.a % 3 === 0 ? null : pick(lives, sel.a) ?? null;
          return { t: "createNote", note: idx, parent, title: `n${idx}`, lines: [`L${idx}.0`, `L${idx}.1`] };
        }
        case "editBody": {
          const k = pick(lives, sel.a); if (k === undefined) return null;
          const n = m.notes[k]!;
          const order = [...n.liveLines].sort((a, b) => n.pos[a]! - n.pos[b]!);
          const target = order.length ? order[sel.b % order.length]! : null;
          const how = sel.c % 3;
          if (how === 0 || order.length < 2) return { t: "editBody", note: k, after: sel.b % (order.length + 1) === 0 ? null : order[(sel.b % (order.length + 1)) - 1]!, inserted: [line(0)], removed: [] };
          if (how === 1) return { t: "editBody", note: k, after: null, inserted: [], removed: [target!] };
          const at = order.indexOf(target!);
          return { t: "editBody", note: k, after: at === 0 ? null : order[at - 1]!, inserted: [line(0)], removed: [target!] };
        }
        case "rename": { const k = pick(lives, sel.a); return k === undefined ? null : { t: "rename", note: k, title: `n${idx}` }; }
        case "move": {
          const k = pick(lives, sel.a); if (k === undefined) return null;
          const sub = subtreeOf(m, k);
          const dests: Array<number | null> = [null, ...lives.filter((x) => !sub.includes(x))].filter((x) => x !== m.notes[k]!.parent);
          const parent = pick(dests, sel.b);
          return parent === undefined ? null : { t: "move", note: k, parent };
        }
        case "tagApply": case "tagRemove": {
          const k = pick(lives, sel.a); const tags = Object.keys(m.tagNames).map(Number);
          const t = pick(tags, sel.b); if (k === undefined || t === undefined) return null;
          return { t: sel.kind, note: k, tag: t };
        }
        case "tagRename": {
          const t = pick(Object.keys(m.tagNames).map(Number), sel.a); if (t === undefined) return null;
          if (INCLUDE_KNOWN) {
            const free = ["pa", "pb", "pc"].map((s) => `${this.prefix}${s}`).filter((nm) => !Object.values(m.tagNames).includes(nm));
            const name = pick(free, sel.b);
            return name === undefined ? null : { t: "tagRename", tag: t, name };
          }
          return { t: "tagRename", tag: t, name: `${this.prefix}r${idx}` };
        }
        case "createTag": {
          const t = Object.keys(m.tagNames).length;
          if (t >= 3) return null;
          return { t: "createTag", tag: t, name: `${this.prefix}c${idx}` };
        }
        case "attrSet": { const k = pick(lives, sel.a); return k === undefined ? null : { t: "attrSet", note: k, key: ATTR_KEYS[sel.b % 2]!, value: `v${idx}` }; }
        case "attrClear": {
          const withAttr = lives.filter((k) => Object.keys(m.notes[k]!.attrs).length);
          const k = pick(withAttr, sel.a); if (k === undefined) return null;
          const keys = Object.keys(m.notes[k]!.attrs);
          return { t: "attrClear", note: k, key: keys[sel.b % keys.length]! };
        }
        case "delete": { const k = pick(lives, sel.a); return k === undefined ? null : { t: "delete", note: k }; }
        case "undelete": {
          const roots = Object.keys(m.notes).map(Number).filter((k) => {
            const n = m.notes[k]!;
            return !n.live && n.deletedBy !== null && m.rootOf[n.deletedBy] === k && (n.parent === null || m.notes[n.parent]!.live);
          });
          const k = pick(roots, sel.a); return k === undefined ? null : { t: "undelete", note: k };
        }
        case "edgeCreate": {
          if (lives.length < 2) return null;
          const src = lives[sel.a % lives.length]!; const dst = lives[(sel.a + 1 + (sel.b % (lives.length - 1))) % lives.length]!;
          if (Object.values(m.edges).some((e) => e.src === src && e.dst === dst)) return null;
          return { t: "edgeCreate", edge: idx, src, dst };
        }
        case "edgeDelete": { const e = pick(Object.keys(m.edges).map(Number), sel.a); return e === undefined ? null : { t: "edgeDelete", edge: e }; }
      }
    }

    // ── Doing it for real ─────────────────────────────────────────────────────

    async send(op: Op): Promise<Reply> {
      const m = this.model; // state BEFORE the op
      const id = (k: number) => this.noteIds.get(k)!;
      switch (op.t) {
        case "createNote": {
          const r = await call("/api/nodes", "POST", {
            space_id: spaceId, title: this.prefix + op.title, markdown: `${op.lines.join("\n")}\n`,
            ...(op.parent !== null ? { parent_id: id(op.parent) } : {}),
          });
          if (r.status === 201) this.noteIds.set(op.note, r.body.id);
          return r;
        }
        case "editBody": {
          const n = clone(m).notes[op.note]!;
          const base = bodyOf(n);
          const after = clone(m); applyOp(after, op);
          return call(`/api/nodes/${id(op.note)}`, "PATCH", { markdown: bodyOf(after.notes[op.note]!), base_markdown: stored(base) });
        }
        case "rename": return call(`/api/nodes/${id(op.note)}`, "PATCH", { title: this.prefix + op.title });
        case "move": return call(`/api/nodes/${id(op.note)}`, "PATCH", op.parent === null ? { parent_id: null, space_id: spaceId } : { parent_id: id(op.parent) });
        case "tagApply": return call(`/api/nodes/${id(op.note)}/tags/${this.tagIds.get(op.tag)}`, "PUT");
        case "tagRemove": return call(`/api/nodes/${id(op.note)}/tags/${this.tagIds.get(op.tag)}`, "DELETE");
        case "tagRename": return call(`/api/tags/${this.tagIds.get(op.tag)}`, "PATCH", { name: op.name });
        case "createTag": {
          const r = await call("/api/tags", "POST", { name: op.name });
          if (r.status === 201) this.tagIds.set(op.tag, r.body.id);
          return r;
        }
        case "attrSet": return call(`/api/nodes/${id(op.note)}/attributes/${op.key}`, "PUT", { value: op.value });
        case "attrClear": return call(`/api/nodes/${id(op.note)}/attributes/${op.key}`, "DELETE");
        case "delete": return call(`/api/nodes/${id(op.note)}`, "DELETE");
        case "undelete": return call(`/api/nodes/${id(op.note)}/undelete`, "POST");
        case "edgeCreate": {
          const r = await call("/api/edges", "POST", { source_node_id: id(op.src), target_node_id: id(op.dst), edge_type: "knowledge_link" });
          if (r.status === 201) this.edgeIds.set(op.edge, r.body.id);
          return r;
        }
        case "edgeDelete": return call(`/api/edges/${this.edgeIds.get(op.edge)}`, "DELETE");
      }
    }

    describe(op: Op): string {
      const { t, ...rest } = op;
      return `${t} ${JSON.stringify(rest)}`;
    }

    async run(sels: Sel[]): Promise<void> {
      await this.seedTags();
      await this.seedNotes();
      for (let idx = 0; idx < sels.length; idx++) {
        const op = this.choose(sels[idx]!, idx);
        if (!op) continue;
        const before = this.model;
        const next = clone(before);
        if (!applyOp(next, op)) continue; // the selector named something that is not possible now
        const slots = slotsOf(op, before);
        const inverse = inverseOf(op, before);
        const marker = await this.lastEventId();
        const reply = await this.send(op);
        if (reply.status < 200 || reply.status >= 300) this.fail(`#${idx} ${this.describe(op)} was refused: ${describeReply(reply)}`);
        this.model = next;
        const events = (await q<{ id: string; event_type: string }>(
          `SELECT id::text, event_type FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint AND triggered_by_event_id IS NULL ORDER BY domain_events.id`,
          [workspaceId, marker])).rows;
        if (!events[0]) this.fail(`#${idx} ${this.describe(op)} recorded no event`);
        const done: Done = {
          idx, op, label: this.describe(op), eventId: events[0].id, eventType: events[0].event_type, slots, inverse,
          unsupported: inverse === null,
          body: op.t === "editBody" ? { note: op.note, inserted: op.inserted, removed: op.removed, after: op.after } : null,
        };
        this.ops.push(done);
        this.log(`do #${idx} ${done.label} → event ${done.eventId} ${done.eventType}`);
      }
    }

    // ── Observing the database in the model's shape ───────────────────────────

    noteKeys(): number[] { return [...this.noteIds.keys()]; }
    tagKeys(): number[] { return [...this.tagIds.keys()]; }

    async observe(): Promise<View> {
      const ids = [...this.noteIds.values()];
      const keyOf = new Map([...this.noteIds].map(([k, v]) => [v, k]));
      const tagKeyOf = new Map([...this.tagIds].map(([k, v]) => [v, k]));
      const notes = (await q<{ id: string; title: string; parent_id: string | null; markdown: string; live: boolean }>(
        `SELECT id::text, title, parent_id::text, markdown, deleted_at IS NULL AS live FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [workspaceId, ids])).rows;
      const tags = (await q<{ node_id: string; tag_id: string }>(`SELECT node_id::text, tag_id::text FROM node_tags WHERE node_id = ANY($1::uuid[])`, [ids])).rows;
      const attrs = (await q<{ node_id: string; key: string; value: string }>(
        `SELECT node_id::text, key, value FROM node_attributes WHERE node_id = ANY($1::uuid[]) AND key = ANY($2::text[])`, [ids, ATTR_KEYS])).rows;
      const tagRows = (await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, [...this.tagIds.values()]])).rows;
      const edgeRows = this.edgeIds.size
        ? (await q<{ s: string; t: string }>(`SELECT source_node_id::text AS s, target_node_id::text AS t FROM node_edges WHERE id = ANY($1::uuid[])`, [[...this.edgeIds.values()]])).rows
        : [];
      const view: View = { notes: {}, tagNames: {}, edges: edgeRows.map((e) => `${keyOf.get(e.s)}>${keyOf.get(e.t)}`).sort() };
      for (const n of notes) {
        const k = keyOf.get(n.id)!;
        view.notes[k] = {
          live: n.live,
          title: n.title.slice(this.prefix.length),
          parent: n.parent_id === null ? null : keyOf.get(n.parent_id) ?? -1,
          body: n.markdown,
          tags: tags.filter((t) => t.node_id === n.id).map((t) => tagKeyOf.get(t.tag_id)!).sort(),
          attrs: attrs.filter((a) => a.node_id === n.id).map((a) => `${a.key}=${a.value}`).sort(),
        };
      }
      for (const t of tagRows) view.tagNames[tagKeyOf.get(t.id)!] = t.title;
      return view;
    }

    /** The model's view with this run's prefix on tag names (as stored). */
    modelView(m: Model, looseBody: number | null = null): View {
      return viewOf(m, this.noteKeys(), this.tagKeys(), looseBody);
    }

    // ── Dependence ────────────────────────────────────────────────────────────

    /** Gaps (between consecutive lines of `universe`, in position order) that
     *  an edit touched. Lines absent from the body now do not separate gaps. */
    gapsOf(d: Done, universe: Set<string>): Set<string> {
      const b = d.body!;
      const pos = this.model.notes[b.note]!.pos;
      const touched = [...b.inserted, ...b.removed];
      const order = [...new Set([...universe, ...touched])].sort((x, y) => pos[x]! - pos[y]!);
      const gaps = new Set<string>();
      for (const l of touched) {
        const i = order.indexOf(l);
        gaps.add(`${order[i - 1] ?? "^"}|${l}`);
        gaps.add(`${l}|${order[i + 1] ?? "$"}`);
      }
      return gaps;
    }

    /** Whether something other than `e` still changed the lines `e` changed. */
    entangled(e: Done, undone: Set<number>, current: Model): boolean {
      for (const f of this.ops) {
        if (f.idx === e.idx || !f.body || f.body.note !== e.body!.note) continue;
        // Changes since e: later edits still in, earlier edits taken back.
        const differs = f.idx > e.idx ? !undone.has(f.idx) : undone.has(f.idx);
        if (!differs) continue;
        const universe = new Set([...(current.notes[e.body!.note]?.liveLines ?? []), ...e.body!.inserted, ...e.body!.removed, ...f.body.inserted, ...f.body.removed]);
        const mine = this.gapsOf(e, universe);
        for (const g of this.gapsOf(f, universe)) if (mine.has(g)) return true;
      }
      return false;
    }

    dependent(e: Done, undone: Set<number>, takenLive: Set<string>, current: Model): boolean {
      const mine = new Set(e.slots.writes);
      for (const f of this.ops) {
        if (f.idx <= e.idx || undone.has(f.idx)) continue;
        if ([...f.slots.reads, ...f.slots.writes].some((s) => mine.has(s))) return true;
        // f changed something e's undo relies on (a parent chain, a live note).
        if (f.slots.writes.some((s) => e.slots.reads.includes(s))) return true;
      }
      if ([...e.slots.reads, ...e.slots.writes].some((s) => takenLive.has(s))) return true;
      // What e assumed about (its reads) was changed by an event already taken back.
      for (const u of this.ops) {
        if (u.idx !== e.idx && undone.has(u.idx) && u.slots.writes.some((s) => e.slots.reads.includes(s))) return true;
      }
      return e.body !== null && this.entangled(e, undone, current);
    }
  }

  // ── Selectors ─────────────────────────────────────────────────────────────

  type Kind = "createNote" | "editBody" | "rename" | "move" | "tagApply" | "tagRemove" | "tagRename" | "createTag"
    | "attrSet" | "attrClear" | "delete" | "undelete" | "edgeCreate" | "edgeDelete";
  type Sel = { kind: Kind; a: number; b: number; c: number };
  const WEIGHTED: Kind[] = [
    "createNote", "createNote", "editBody", "editBody", "editBody", "editBody", "editBody", "editBody",
    "rename", "rename", "move", "move", "tagApply", "tagApply", "tagRemove", "tagRemove", "tagRename", "createTag",
    "attrSet", "attrSet", "attrSet", "attrClear", "attrClear", "delete", "delete", "undelete", "undelete",
    "edgeCreate", "edgeDelete",
  ];
  const selArb: fc.Arbitrary<Sel> = fc.record({
    kind: fc.constantFrom(...WEIGHTED), a: fc.nat(9), b: fc.nat(9), c: fc.nat(9),
  });
  /** `any` (1 in 6): pick among all events, edges and tag creation included;
 *  otherwise among the events that have an inverse. */
const plan = fc.array(fc.record({ pick: fc.nat(30), again: fc.boolean(), any: fc.integer({ min: 0, max: 5 }).map((n) => n === 0) }), { minLength: 1, maxLength: 8 });

  // ── The restore phase ─────────────────────────────────────────────────────

  /** What the random runs actually exercised (printed after the property). */
  const stats = { runs: 0, restored: 0, mustRestore: 0, again: 0, refused: {} as Record<string, number>, byType: {} as Record<string, number> };

  async function restorePhase(w: World, steps: Array<{ pick: number; again: boolean; any: boolean }>): Promise<void> {
    if (!w.ops.length) return;
    const undone = new Set<number>();
    const takenLive = new Set<string>(); // live slots of notes structural restores deleted / revived
    let current = w.model; // the model of the database right now
    const noteKeys = w.noteKeys();
    const tagKeys = w.tagKeys();
    let independentOnly = true;

    for (const step of steps) {
      const open = w.ops.filter((d) => !undone.has(d.idx));
      const candidates = step.any ? open : open.filter((d) => !d.unsupported);
      if (!candidates.length) continue;
      const e = candidates[step.pick % candidates.length]!;
      const before = await w.observe();
      const marker = await w.lastEventId();
      const reply = await call(`/api/events/${e.eventId}/restore`, "POST", {});
      const after = await w.observe();
      const newEvents = await w.eventCountSince(marker);
      const tag = `restore #${e.idx} ${e.label} (event ${e.eventId})`;
      w.log(`${tag} → ${describeReply(reply)}`);

      if (reply.status >= 500) w.fail(`${tag}: server error ${describeReply(reply)}`);
      const refused = reply.status !== 200;
      stats.byType[e.eventType] = (stats.byType[e.eventType] ?? 0) + 1;
      if (refused) stats.refused[String(reply.body?.error)] = (stats.refused[String(reply.body?.error)] ?? 0) + 1;
      else stats.restored++;
      if (refused && !isRefusal(reply)) w.fail(`${tag}: unexpected answer ${describeReply(reply)}`);

      if (e.unsupported) {
        if (!(refused && reply.body.error === "unsupported")) w.fail(`${tag}: an event with no inverse must answer unsupported, got ${describeReply(reply)}`);
      }

      if (refused) {
        if (JSON.stringify(after) !== JSON.stringify(before)) w.fail(`${tag}: refused, but the state changed\nbefore ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`);
        if (newEvents !== 0) w.fail(`${tag}: refused, but ${newEvents} event(s) were recorded`);
      }

      const dependent = w.dependent(e, undone, takenLive, current);
      const target = e.inverse ? e.inverse(current) : null;
      const looseNote = e.body !== null && w.entangled(e, undone, current) ? e.body.note : null;
      const wanted = target ? w.modelView(target, looseNote) : null;
      const noChange = wanted !== null && JSON.stringify(w.modelView(target!, looseNote)) === JSON.stringify(w.modelView(current, looseNote));

      if (!refused) {
        if (e.unsupported) w.fail(`${tag}: restored an event that has no inverse`);
        if (!wanted || noChange) w.fail(`${tag}: reported success, but there was nothing to take back (state ${JSON.stringify(after)})`);
        if (JSON.stringify(after) === JSON.stringify(before)) w.fail(`${tag}: reported success, but nothing changed`);
        const got = looseNote === null ? after : looseBodyView(after, looseNote);
        if (JSON.stringify(got) !== JSON.stringify(wanted)) {
          w.fail(`${tag}: restored to the wrong state\nexpected ${JSON.stringify(wanted)}\nactual   ${JSON.stringify(got)}`);
        }
        if (newEvents < 1) w.fail(`${tag}: reported success, but no restore event was recorded`);
        await w.expectVersionShape(marker, tag);
        // A note whose title the undo changed ends with the slug an ordinary rename to that title gives it.
        for (const k of noteKeys) {
          if (!after.notes[k]?.live || after.notes[k]!.title === before.notes[k]?.title) continue;
          const id = w.noteIds.get(k);
          const stored = id && (await q<{ id: string; title: string; slug: string; node_type: string; reserved_key: string | null }>(
            `SELECT id, title, slug, node_type, reserved_key FROM content_nodes WHERE id = $1`, [id])).rows[0];
          if (stored && stored.slug !== await slugForTitle(workspaceId, stored, stored.title)) {
            w.fail(`${tag}: note ${k} has title "${stored.title}" but slug "${stored.slug}", not what a rename to that title gives`);
          }
        }
        // Other writers' lines survive an undo of a body edit.
        if (e.body) {
          const keep = current.notes[e.body.note]!.liveLines.filter((l) => !e.body!.inserted.includes(l));
          const text = after.notes[e.body.note]?.body ?? "";
          for (const l of keep) if (!text.includes(stored(l))) w.fail(`${tag}: line ${l} of another edit was dropped by the undo`);
        }
        // Bookkeeping: what the structural restore touched can no longer be judged by slots.
        if (e.eventType === "NODE_CREATED" || e.eventType === "NODE_DELETED" || e.eventType === "NODE_UNDELETED") {
          for (const k of noteKeys) if (JSON.stringify(current.notes[k]?.live) !== JSON.stringify(target!.notes[k]?.live)) takenLive.add(`live:${k}`);
        }
        if (looseNote !== null) {
          // keep the model exact: take the lines the database actually has
          const lines = after.notes[looseNote]!.body.split("\n").filter(Boolean);
          const fixed = clone(target!);
          const n = fixed.notes[looseNote]!;
          const byStored = new Map(Object.keys(n.pos).map((l) => [stored(l), l]));
          const kept = lines.map((l) => byStored.get(l)!).filter(Boolean);
          // The merge placed lines where it saw fit: adopt that order, and let
          // each line that is out of the body follow the line it used to follow.
          const oldOrder = Object.keys(n.pos).sort((x, y) => n.pos[x]! - n.pos[y]!);
          const fresh: Record<string, number> = {};
          kept.forEach((l, i) => { fresh[l] = (i + 1) * 1024; });
          let anchor = 0; let bump = 0;
          for (const l of oldOrder) {
            if (fresh[l] !== undefined) { anchor = fresh[l]!; bump = 0; } else fresh[l] = anchor + (++bump) * 0.001;
          }
          n.pos = fresh;
          n.liveLines = kept;
          current = fixed;
        } else {
          current = target!;
        }
        undone.add(e.idx);
        if (dependent) independentOnly = false; else stats.mustRestore++;
        if (!dependent && wanted === null) w.fail("unreachable");
        // An event restored a second time: refused, and nothing changes.
        if (step.again) {
          const marker2 = await w.lastEventId();
          const again = await call(`/api/events/${e.eventId}/restore`, "POST", {});
          const afterAgain = await w.observe();
          w.log(`again ${tag} → ${describeReply(again)}`);
          stats.again++;
          if (again.status >= 500) w.fail(`${tag}: second restore: server error ${describeReply(again)}`);
          if (again.status === 200) w.fail(`${tag}: restoring the same event twice reported success a second time`);
          if (!isRefusal(again)) w.fail(`${tag}: second restore: unexpected answer ${describeReply(again)}`);
          if (JSON.stringify(afterAgain) !== JSON.stringify(after)) w.fail(`${tag}: second restore refused, but the state changed`);
          if ((await w.eventCountSince(marker2)) !== 0) w.fail(`${tag}: second restore refused, but recorded an event`);
        }
      } else if (!dependent && !e.unsupported) {
        // Nothing depends on it: it has to work, unless it would change nothing.
        if (wanted && !noChange) {
          w.fail(`${tag}: refused with ${reply.body.error} (${reply.body.detail}), but no surviving event depends on it`);
        }
      }
    }

    // The original sequence without the undone events, when nothing depended on them.
    if (independentOnly && undone.size) {
      const replay = emptyModel();
      Object.assign(replay, clone(w.seedModel));
      let skipped = false;
      for (const d of w.ops) {
        if (!undone.has(d.idx) && !applyOp(replay, d.op)) skipped = true;
      }
      if (!skipped) {
        const finalView = await w.observe();
        const expected = w.modelView(replay);
        const looseKeys = [...undone].map((i) => w.ops.find((d) => d.idx === i)!).filter((d) => d.body).map((d) => d.body!.note);
        const liveOnly = (v: View): View => ({ ...v, notes: Object.fromEntries(Object.entries(v.notes).map(([k, n]) => [k, n.live ? n : { live: false, title: "", parent: null, body: "", tags: [], attrs: [] }])) });
        const compare = (v: View) => JSON.stringify(looseKeys.reduce((acc, k) => looseBodyView(acc, k), liveOnly(v)));
        // tag renames undone return the earlier name: the model's current name of a tag is its replayed name
        if (compare(finalView) !== compare(expected)) {
          w.fail(`final state differs from replaying the sequence without the undone events ${[...undone].map((i) => "#" + i).join(", ")}\nreplayed ${compare(expected)}\nactual   ${compare(finalView)}`);
        }
      }
    }
  }

  function looseBodyView(v: View, note: number): View {
    const n = v.notes[note];
    if (!n) return v;
    return { ...v, notes: { ...v.notes, [note]: { ...n, body: n.body.split("\n").filter(Boolean).sort().join("\n") } } };
  }

  // ── The property ──────────────────────────────────────────────────────────

  it(`random operations, then random restores keep the state exact or refuse cleanly (seed ${PROPS_SEED}${INCLUDE_KNOWN ? ", known bugs included" : ""})`, async () => {
    await checkAsync(
      fc.asyncProperty(fc.array(selArb, { minLength: 4, maxLength: 16 }), plan, async (sels, steps) => {
        const w = new World();
        stats.runs++;
        await w.run(sels);
        await restorePhase(w, steps);
      }),
      RUN_CAP,
    );
    console.log(`[history props] seed ${PROPS_SEED}: ${JSON.stringify(stats)}`);
  }, 600_000);

  // ── Named cases ───────────────────────────────────────────────────────────

  const mkNote = async (title: string, markdown: string, parentId?: string): Promise<string> => {
    const r = await call("/api/nodes", "POST", { space_id: spaceId, title: `HP${stamp}-${title}`, markdown, ...(parentId ? { parent_id: parentId } : {}) });
    expect(r.status).toBe(201);
    return r.body.id;
  };
  const patch = async (id: string, json: Record<string, unknown>) => expect((await call(`/api/nodes/${id}`, "PATCH", json)).status).toBe(200);
  const lastEvent = async (type: string, targetId: string) => (await q<{ id: string }>(
    `SELECT id::text FROM domain_events WHERE workspace_id = $1 AND event_type = $2 AND target_id = $3 ORDER BY domain_events.id DESC LIMIT 1`, [workspaceId, type, targetId])).rows[0]!.id;
  const bodyNow = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
  const restore = (eventId: string, json: Record<string, unknown> = {}) => call(`/api/events/${eventId}/restore`, "POST", json);

  it("M10: undoing a title-only change records title and body_hash", async () => {
    const id = await mkNote("m10", "same\n");
    await patch(id, { title: `HP${stamp}-m10-b` });
    const r = await restore(await lastEvent("NODE_UPDATED", id));
    expect(r.status).toBe(200);
    const ev = (await q<{ payload: { title?: string; body_hash?: string } }>(
      `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' ORDER BY id DESC LIMIT 1`, [id])).rows[0]!;
    expect(ev.payload.title).toBe(`HP${stamp}-m10`);
    expect(ev.payload.body_hash).toBeTruthy();
  });

  it("restoring a delete brings back exactly the subtree deleted together", async () => {
    const parent = await mkNote("sub-p", "p\n");
    const kept = await mkNote("sub-early", "early\n", parent);   // deleted on its own, earlier
    const child = await mkNote("sub-child", "child\n", parent);
    const grandchild = await mkNote("sub-grand", "grand\n", child);
    expect((await call(`/api/nodes/${kept}`, "DELETE")).status).toBe(200);
    expect((await call(`/api/nodes/${parent}`, "DELETE")).status).toBe(200);
    const live = async (id: string) => (await q<{ d: boolean }>(`SELECT deleted_at IS NULL AS d FROM content_nodes WHERE id = $1`, [id])).rows[0]!.d;
    expect([await live(parent), await live(child), await live(grandchild), await live(kept)]).toEqual([false, false, false, false]);

    const r = await restore(await lastEvent("NODE_DELETED", parent));
    expect(r.status).toBe(200);
    expect([await live(parent), await live(child), await live(grandchild), await live(kept)]).toEqual([true, true, true, false]);
    // the same restore again: refused, nothing moves
    const again = await restore(await lastEvent("NODE_DELETED", parent));
    expect(isRefusal(again)).toBe(true);
    expect([await live(parent), await live(child), await live(grandchild), await live(kept)]).toEqual([true, true, true, false]);
  });

  it("an undo keeps another event's lines; a conflicting undo is refused and loses nothing, force says it overwrote", async () => {
    const id = await mkNote("merge", "one\ntwo\nthree\n");
    await patch(id, { markdown: "one\ntwo (a)\nthree\n", base_markdown: "one\ntwo\nthree\n" });
    const a = await lastEvent("NODE_UPDATED", id);
    await patch(id, { markdown: "one\ntwo (a)\nthree (b)\n", base_markdown: "one\ntwo (a)\nthree\n" });
    const r1 = await restore(a);
    expect(r1.status).toBe(200);
    expect(await bodyNow(id)).toBe("one\ntwo\nthree (b)\n");

    const c = await mkNote("conflict", "x\ny\nz\n");
    await patch(c, { markdown: "x\ny1\nz\n", base_markdown: "x\ny\nz\n" });
    const first = await lastEvent("NODE_UPDATED", c);
    await patch(c, { markdown: "x\ny2\nz\n", base_markdown: "x\ny1\nz\n" });
    const second = await lastEvent("NODE_UPDATED", c);
    const refused = await restore(first);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("patch_conflict");
    expect(await bodyNow(c)).toBe("x\ny2\nz\n");
    const forced = await restore(first, { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.overwrote_later_edits).toBe(true);
    expect(await bodyNow(c)).toBe("x\ny\nz\n");
    // The overwritten line is not dropped: the edit that wrote it keeps its body.
    const hash = (await q<{ h: string }>(`SELECT payload->>'body_hash' AS h FROM domain_events WHERE id = $1::bigint`, [second])).rows[0]!.h;
    expect((await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [hash])).rows[0]!.content).toContain("y2");
  });

  it("events with no inverse (edges, tag creation) are refused as unsupported", async () => {
    const a = await mkNote("edge-a", "a\n");
    const b = await mkNote("edge-b", "b\n");
    const edge = await call("/api/edges", "POST", { source_node_id: a, target_node_id: b, edge_type: "knowledge_link" });
    expect(edge.status).toBe(201);
    const r = await restore(await lastEvent("EDGE_CREATED", edge.body.id));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("unsupported");
    expect((await q(`SELECT 1 FROM node_edges WHERE id = $1`, [edge.body.id])).rowCount).toBe(1);
  });

  // F1 (found by the random run): undoing a note edit whose effect a later
  // edit already took back used to say "restored" and record an edit that
  // changed nothing. Every other kind of event answers already_in_state here.
  it("F1 undoing an edit whose lines a later edit already took back is refused, not a no-op success", async () => {
    const id = await mkNote("f1", "keep\n");
    await patch(id, { markdown: "new\nkeep\n", base_markdown: "keep\n" });
    const added = await lastEvent("NODE_UPDATED", id);
    await patch(id, { markdown: "keep\n", base_markdown: "new\nkeep\n" });
    const marker = await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE target_id = $1`, [id]);
    const r = await restore(added);
    expect(await bodyNow(id)).toBe("keep\n");
    expect(r.status).not.toBe(200);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE target_id = $1`, [id])).rows[0]!.n).toBe(marker.rows[0]!.n);
  });

  // Known bugs: data-integrity.md #20 and #22. Both are fixed in PR
  // fix/a2-structure-import-backup; these flip to plain passes (vitest then
  // reports the it.fails) once that PR is merged.

  it(`#20 undoing a tag rename onto a name another tag took is a state_conflict, not a 500`, async () => {
    const aName = `HP${stamp}-t20a`;
    const t1 = (await call("/api/tags", "POST", { name: aName })).body.id as string;
    const t2 = (await call("/api/tags", "POST", { name: `HP${stamp}-t20b` })).body.id as string;
    expect((await call(`/api/tags/${t1}`, "PATCH", { name: `HP${stamp}-t20c` })).status).toBe(200);
    const rename = await lastEvent("TAG_UPDATED", t1);
    expect((await call(`/api/tags/${t2}`, "PATCH", { name: aName })).status).toBe(200);
    const r = await restore(rename);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("state_conflict");
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [t1])).rows[0]!.title).toBe(`HP${stamp}-t20c`);
  });

  it(`#22 undoing a body edit that has no inverse patch (lone surrogate) is refused, not reported as success (fixed in ${FIXED_PR})`, async () => {
    const id = await mkNote("t22", "alpha\n");
    await patch(id, { markdown: `alpha\nbeta${LONE}\n`, base_markdown: "alpha\n" });
    const edit = await lastEvent("NODE_UPDATED", id);
    const before = await bodyNow(id);
    const r = await restore(edit);
    // either the body really went back, or the restore said it could not
    if (r.status === 200) expect(await bodyNow(id)).toBe("alpha\n");
    else expect(r.body.error).toBe("history_incomplete");
    expect(before).not.toBe("alpha\n");
  });
});

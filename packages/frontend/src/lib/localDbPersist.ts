import { upsertWorkspaceInto } from "./workspaceMirror";
import { upsertTaskInto } from "./taskMirror";
import { upsertNodeInto, upsertEdgeInto, upsertPointerInto, upsertAttributeInto, fillAttributeInto, type MirrorAttribute } from "./localMirror";
// Pure, sql.js-free persist logic for the local SQLite mirror. Extracted from
// localDbWorker.ts so it can be unit-tested against a real sql.js Database in
// Node (the worker module can't load wasm under jsdom, and imports sql.js at the
// top level). The worker delegates persistBootstrap here, passing its own db.run.
//
// non-clobber (review #3, HIGH-B): a SLIM bootstrap (bodies==="none") carries
// every node SKELETON but markdown=="" for all of them, and — by design — may be
// the only payload a big workspace ever persists. A DELETE-then-INSERT wholesale
// replace would (a) wipe any body the user had already hydrated locally,
// replacing it with "", and (b) — if the bootstrap were ever truncated —
// delete every node past the truncation from a previously-complete mirror. Both
// are data loss. So a slim/partial bootstrap MERGES (upsert), never deletes; an
// already-stored body is PRESERVED when this payload's body is empty (the slim
// "" must not overwrite a hydrated body unless body_len explicitly confirms 0).
// A FULL bootstrap carries every body and
// IS the complete authoritative set, so it keeps the destructive replace.
import type { BindParams, Database, Statement } from "sql.js";
import type { Bootstrap, GraphPosition, Tag } from "./api";
import { tagFromNode } from "./tagProjection";
import type { CanvasMembershipChange } from "./canvasMemberships";
import type { LinkBinding, NoteAnchor } from "./blockAnchorStore";
import type { CanvasMembership } from "@onden/contract";
import { isTag } from "@onden/markdown/contract";

/** Minimal write surface — exactly sql.js's Database.run, so the worker can pass
 *  its own db and a test can pass a real sql.js Database. The return type is
 *  loosened to unknown so a structural match doesn't require importing Database. */
export interface DbRun {
  run(sql: string, params?: BindParams): unknown;
}

export function persistTagCatalogInto(d: DbRun, tags: Tag[]): void {
  d.run("INSERT INTO sync_state(key,value) VALUES('tags_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(tags)]);
}

/** Slim-bootstrap deletion reconcile (HIGH gap #2). A slim (?bodies=none)
 *  bootstrap only UPSERTS, so a node the server has since deleted — or that
 *  became unreadable — lingered in the mirror and reappeared on cold-start (the
 *  "deleted note comes back on refresh" bug on workspaces past the slim
 *  threshold). Given the slim payload's node ids (the authoritative readable
 *  set) and the mirror's node ids, return the ids to DROP: those absent from the
 *  remote payload. Pending requests never protect cached metadata; new notes
 *  are reconstructed separately from their durable input after this cleanup. */
export function slimBootstrapNodeDrops(
  presentIds: Set<string>,
  mirrorIds: string[],
): string[] {
  return mirrorIds.filter((id) => !presentIds.has(id));
}

/** Drop a node AND its dependent rows from the mirror (H17). The slim-bootstrap
 *  reconcile used to delete only the node + FTS row, leaving the dropped node's
 *  tasks, edges, and attributes (e.g. sketch_data) behind — a read-policy leak:
 *  a revoked/deleted node's data survived in the offline mirror. Cascade the same
 *  way applySync's node-delete and removeNode do (tasks by node_id OR id; edges
 *  by either endpoint; all attributes). FTS is best-effort (may be unavailable). */
export function dropNodeFromMirror(d: DbRun, id: string): void {
  d.run("DELETE FROM nodes WHERE id = ?", [id]);
  try { d.run("DELETE FROM nodes_fts WHERE id = ?", [id]); } catch { /* FTS best-effort */ }
  d.run("DELETE FROM tasks WHERE node_id = ? OR id = ?", [id, id]);
  d.run("DELETE FROM edges WHERE source_node_id = ? OR target_node_id = ?", [id, id]);
  d.run("DELETE FROM pointers WHERE parent_id = ? OR target_id = ?", [id, id]);
  d.run("DELETE FROM node_attributes WHERE node_id = ?", [id]);
  d.run("DELETE FROM canvas_memberships WHERE node_id = ? OR canvas_id = ?", [id, id]);
  d.run("DELETE FROM graph_positions WHERE node_id = ?", [id]);
  d.run("DELETE FROM note_anchors WHERE note_id = ?", [id]);
  d.run("DELETE FROM note_link_bindings WHERE note_id = ?", [id]);
}

/** Reads every held anchor back in the wire shape (the cold-start load; the same query for the worker and the tests). */
export const NOTE_ANCHORS_SELECT = `SELECT anchor_id, note_id, pos_from AS "from", pos_to AS "to", status, cand_from AS candidate_from, cand_to AS candidate_to, quote
  FROM note_anchors ORDER BY note_id, pos_from`;

/** One note's anchors as the server ships them: they replace what is held for the note. */
function putNoteAnchorsInto(d: DbRun, rows: readonly NoteAnchor[]): void {
  for (const a of rows) {
    d.run(
      `INSERT INTO note_anchors (anchor_id, note_id, pos_from, pos_to, status, cand_from, cand_to, quote) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(anchor_id) DO UPDATE SET note_id = excluded.note_id, pos_from = excluded.pos_from, pos_to = excluded.pos_to,
         status = excluded.status, cand_from = excluded.cand_from, cand_to = excluded.cand_to, quote = excluded.quote`,
      [a.anchor_id, a.note_id, a.from, a.to, a.status, a.candidate_from, a.candidate_to, a.quote ?? ""],
    );
  }
}

/** A bootstrap's anchors: complete for the notes the payload carries (a slim bootstrap merges, so a note it
 *  does not carry keeps what it had). */
export function persistNoteAnchorsInto(d: DbRun, rows: readonly NoteAnchor[], carriedNoteIds: readonly string[]): void {
  d.run("DELETE FROM note_anchors WHERE note_id IN (SELECT value FROM json_each(?))", [JSON.stringify(carriedNoteIds)]);
  putNoteAnchorsInto(d, rows);
}

/** A sync delta's anchors: complete for the notes in `replace_for` (their old rows go first). */
export function applyNoteAnchorDeltaInto(d: DbRun, delta: { upsert: readonly NoteAnchor[]; replace_for: readonly string[] }): void {
  for (const id of delta.replace_for) d.run("DELETE FROM note_anchors WHERE note_id = ?", [id]);
  putNoteAnchorsInto(d, delta.upsert);
}

/** Every held link binding in the wire shape (the cold-start load). */
export const NOTE_LINK_BINDINGS_SELECT = "SELECT note_id, link_text, anchor_id FROM note_link_bindings ORDER BY note_id, link_text";

function putBindingsInto(d: DbRun, rows: readonly LinkBinding[]): void {
  for (const b of rows) {
    d.run(`INSERT INTO note_link_bindings (note_id, link_text, anchor_id) VALUES (?, ?, ?)
           ON CONFLICT(note_id, link_text) DO UPDATE SET anchor_id = excluded.anchor_id`, [b.note_id, b.link_text, b.anchor_id]);
  }
}

/** A bootstrap's bindings: complete for the notes the payload carries. */
export function persistLinkBindingsInto(d: DbRun, rows: readonly LinkBinding[], carriedNoteIds: readonly string[]): void {
  d.run("DELETE FROM note_link_bindings WHERE note_id IN (SELECT value FROM json_each(?))", [JSON.stringify(carriedNoteIds)]);
  putBindingsInto(d, rows);
}

/** A sync delta's bindings: complete for the notes in `replace_for`. */
export function applyLinkBindingDeltaInto(d: DbRun, delta: { upsert: readonly LinkBinding[]; replace_for: readonly string[] }): void {
  for (const id of delta.replace_for) d.run("DELETE FROM note_link_bindings WHERE note_id = ?", [id]);
  putBindingsInto(d, delta.upsert);
}

/** The boards each note is on, as a bootstrap ships them: the whole list (D98). */
export function persistCanvasMembershipsInto(d: DbRun, rows: readonly CanvasMembership[]): void {
  d.run("DELETE FROM canvas_memberships");
  applyCanvasMembershipChangeInto(d, { upsert: [...rows], delete: [] });
}

/** The same rule as lib/canvasMemberships applyCanvasMembershipChange, on the
 *  mirror: removals first, then rows added or retitled. */
export function applyCanvasMembershipChangeInto(d: DbRun, change: CanvasMembershipChange): void {
  for (const m of change.delete) {
    d.run("DELETE FROM canvas_memberships WHERE canvas_id = ? AND node_id = ?", [m.canvas_id, m.node_id]);
  }
  for (const m of change.upsert) {
    d.run(
      `INSERT INTO canvas_memberships (canvas_id, node_id, canvas_title) VALUES (?, ?, ?)
       ON CONFLICT(canvas_id, node_id) DO UPDATE SET canvas_title = excluded.canvas_title`,
      [m.canvas_id, m.node_id, m.canvas_title ?? ""],
    );
  }
}

/** Hand-placed global-graph positions, as a bootstrap ships them: the whole list. */
export function persistGraphPositionsInto(d: DbRun, rows: readonly GraphPosition[]): void {
  d.run("DELETE FROM graph_positions");
  for (const p of rows) putGraphPositionInto(d, p.nodeId, p);
}

/** One note's graph position, or none (`null` removes it). */
export function putGraphPositionInto(d: DbRun, nodeId: string, position: { x: number; y: number } | null): void {
  if (!position) { d.run("DELETE FROM graph_positions WHERE node_id = ?", [nodeId]); return; }
  d.run(
    `INSERT INTO graph_positions (node_id, x, y) VALUES (?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
    [nodeId, position.x, position.y],
  );
}

/** The workspace row, its settings, timezone and suggestions: the
 *  parts of a snapshot that are not per-node. */
function persistWorkspaceInto(d: DbRun, data: Bootstrap): void {
  d.run("DELETE FROM workspace");
  d.run(
    "INSERT INTO workspace (id, name, slug, home_node_id, actor_role, actor_is_owner, can_review) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [data.workspace.id, data.workspace.name, data.workspace.slug, data.workspace.home_node_id ?? null, data.actor_role ?? null,
      data.actor_is_owner === true ? 1 : 0, data.can_review === true ? 1 : 0],
  );

  upsertWorkspaceInto(d, data.workspace, data);
  // The server's calendar zone, so an offline cold start's agenda and "today"
  // use it too (absent from older servers or when ONDEN_TIMEZONE is unset).
  if (data.timezone) d.run("INSERT INTO sync_state(key,value) VALUES('timezone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [data.timezone]);
  else d.run("DELETE FROM sync_state WHERE key='timezone'");
  persistTagCatalogInto(d, data.tags ?? data.nodes.filter(node => isTag(node)).map(tagFromNode));
  // Both ship whole on every bootstrap shape (full, slim, ?nodes=none); an
  // older server that omits them leaves the mirror's copy as it is.
  if (data.canvas_memberships) persistCanvasMembershipsInto(d, data.canvas_memberships);
  if (data.graph_positions) persistGraphPositionsInto(d, data.graph_positions);
  // Absent from a ?nodes=none snapshot and from older servers: what is held stays.
  if (data.note_anchors) persistNoteAnchorsInto(d, data.note_anchors, data.nodes.map((n) => n.id));
  if (data.note_link_bindings) persistLinkBindingsInto(d, data.note_link_bindings, data.nodes.map((n) => n.id));
  // Suggestions are small and not body-bearing — replaced on both paths.
  d.run("DELETE FROM suggestions");
  for (const s of data.suggestions) {
    d.run(
      "INSERT INTO suggestions (id, target_id, suggestion_type, payload, status, reasoning) VALUES (?, ?, ?, ?, ?, ?)",
      [s.id, s.target_id, s.suggestion_type, JSON.stringify(s.payload), s.status, s.reasoning ?? null],
    );
  }
}

/** A ?nodes=none snapshot (Bootstrap.nodes_omitted): the workspace parts only.
 *  Every node, edge, task, pointer and attribute row stays as it is. */
export function persistBootstrapMetaInto(d: DbRun, data: Bootstrap): void {
  d.run("BEGIN");
  try {
    persistWorkspaceInto(d, data);
    d.run("COMMIT");
  } catch (e) {
    d.run("ROLLBACK");
    throw e;
  }
}

/** Fill in server attribute values this device has no copy of (a drawing
 *  read on open, for offline). A value already here is never replaced: it is
 *  either as new as the server's (the deltas keep it so) or the person's own
 *  unsent input. */
export function fillAttributesInto(d: DbRun, rows: MirrorAttribute[]): void {
  for (const a of rows) fillAttributeInto(d, a);
}

/** One entry of GET /api/sync/drawings: a readable note's drawing value, its
 *  size and the SHA-256 (hex) of its UTF-8 bytes. */
export type DrawingIndexEntry = { node_id: string; key: string; size: number; hash?: string };
/** This device's copy of one drawing value: its hash (null when it cannot be
 *  hashed here) and when the mirror last wrote it (SQLite UTC datetime). */
export type LocalDrawingCopy = { hash: string | null; updated_at: string | null };

/** A local copy written this recently is left alone even when it differs:
 *  the person's strokes reach the mirror a moment before their queued write. */
export const STALE_COPY_MIN_AGE_MS = 60_000;

/** What the offline drawing download still has to fetch:
 *  - `missing`: notes held here with no copy of a value the server has;
 *  - `stale`: copies that differ from the server's (a missed delta, a data
 *    migration with no event), each with the hash it had — replaced only if
 *    it still has that hash when the new value arrives. Never a note with a
 *    queued attribute write, nor a copy written in the last minute: the
 *    person's own unsynced strokes win.
 *  Notes not held here are skipped (the copy belongs to a held note). */
export function planDrawingDownload(
  index: DrawingIndexEntry[], held: Set<string>, local: Map<string, LocalDrawingCopy>,
  queued: Set<string>, nowMs: number,
): { missing: string[]; stale: Array<{ node_id: string; key: string; localHash: string }> } {
  const missing = new Set<string>();
  const stale: Array<{ node_id: string; key: string; localHash: string }> = [];
  for (const entry of index) {
    if (!held.has(entry.node_id)) continue;
    const copy = local.get(drawingCopyKey(entry.node_id, entry.key));
    if (!copy) { missing.add(entry.node_id); continue; }
    if (!entry.hash || !copy.hash || copy.hash === entry.hash || queued.has(entry.node_id)) continue;
    const written = copy.updated_at ? Date.parse(`${copy.updated_at.replace(" ", "T")}Z`) : NaN;
    if (Number.isFinite(written) && nowMs - written < STALE_COPY_MIN_AGE_MS) continue;
    stale.push({ node_id: entry.node_id, key: entry.key, localHash: copy.hash });
  }
  return { missing: [...missing], stale };
}

/** Replace stale copies (planDrawingDownload) with the server's rows — each
 *  only while its note has no queued attribute write and the copy still has
 *  the hash it was planned with: strokes drawn meanwhile change it, and then
 *  the person's copy stays. Resolves to how many were replaced. */
export async function replaceStaleCopiesInto(
  d: DbRun & { exec(sql: string, params?: BindParams): Array<{ values: unknown[][] }> },
  rows: Array<MirrorAttribute & { expected_hash: string }>,
  queued: Set<string>,
  sha256: (text: string) => Promise<string | null>,
): Promise<number> {
  let replaced = 0;
  for (const { expected_hash, ...row } of rows) {
    if (queued.has(row.node_id)) continue;
    const current = d.exec("SELECT value FROM node_attributes WHERE node_id = ? AND key = ?", [row.node_id, row.key])[0]?.values[0]?.[0];
    if (typeof current !== "string" || await sha256(current) !== expected_hash) continue;
    upsertAttributeInto(d, row);
    replaced++;
  }
  return replaced;
}

export const drawingCopyKey = (nodeId: string, key: string) => `${nodeId}\u0000${key}`;

/** Replace/merge a snapshot. Drop obsolete mirrors and their dependents inside
 * the same transaction before inserting the supplied projection. */
export function persistBootstrapInto(d: DbRun & Pick<Database, "prepare">, data: Bootstrap, dropNodeIds: string[] = []): void {
  const slim = data.bodies === "none";
  // Each statement is prepared once and re-bound per row (a plain `run` re-parses
  // it: ~160k rows in a 20k-note payload); freed in `finally`.
  const prepared = new Map<string, Statement>();
  const w: DbRun = { run: (sql, params) => (prepared.get(sql) ?? prepared.set(sql, d.prepare(sql)).get(sql)!).run(params) };
  d.run("BEGIN");
  try {
    for (const id of dropNodeIds) dropNodeFromMirror(d, id);
    persistWorkspaceInto(d, data);

    // Nodes. Full path: wholesale replace. Slim path: upsert the skeleton,
    // keeping the stored body when this payload's markdown is "" via
    // preserving omitted bodies. An explicit body_len=0 (including pending
    // empty input) confirms a cleared body and must replace the cached text.
    if (!slim) d.run("DELETE FROM nodes");
    // FTS is rebuilt wholesale below, so rows skip their own index update.
    for (const n of data.nodes) upsertNodeInto(w, n, { from: "server", bodiesOmitted: slim, index: false });

    // Edges. Slim path upserts (no wholesale delete) so edges of nodes absent
    // from a partial payload survive.
    if (!slim) d.run("DELETE FROM edges");
    for (const e of data.edges) upsertEdgeInto(w, e);

    // Pointers: the bootstrap ships every pointer between the nodes it returns,
    // in both modes, so a present list replaces the mirror. Older servers omit it.
    if (data.pointers) {
      d.run("DELETE FROM pointers");
      for (const p of data.pointers) upsertPointerInto(w, p);
    }

    if (!slim) d.run("DELETE FROM tasks");
    for (const t of data.tasks) {
      upsertTaskInto(w, t);
    }

    // Attrs are a flat {key:value} map per node. Slim path clears + rewrites only
    // the attrs of nodes IN this payload, so nodes absent from a partial payload
    // keep theirs; the full path replaces wholesale.
    // A server that ships typed attributes keeps each one's type, inheritance
    // and source; the flat map (older servers) falls back to the defaults.
    // A lean payload left some keys' values out (drawings): the copies this
    // device holds of those stay, as the payload says nothing about them.
    const kept = data.deferred_attribute_keys?.length ? JSON.stringify(data.deferred_attribute_keys) : null;
    const notKept = kept ? " AND key NOT IN (SELECT value FROM json_each(?))" : "";
    // Slim: one set-based delete, before any insert, of the payload's notes' attributes.
    d.run(`DELETE FROM node_attributes WHERE ${slim ? "node_id IN (SELECT value FROM json_each(?))" : "1=1"}${notKept}`,
      [...(slim ? [JSON.stringify(data.nodes.map((n) => n.id))] : []), ...(kept ? [kept] : [])]);
    if (!slim) {
      // The kept copies of notes this full payload no longer has go with them
      // (a full payload is the whole readable set).
      if (kept) d.run("DELETE FROM node_attributes WHERE node_id NOT IN (SELECT id FROM nodes) AND node_id NOT IN (SELECT id FROM tasks)");
    }
    const typed = new Map<string, NonNullable<Bootstrap["attributes"]>>();
    for (const a of data.attributes ?? []) typed.set(a.node_id, [...(typed.get(a.node_id) ?? []), a]);
    for (const n of data.nodes) {
      if (data.attributes) {
        for (const a of typed.get(n.id) ?? []) upsertAttributeInto(w, a);
        continue;
      }
      for (const [key, value] of Object.entries(n.attrs ?? {})) upsertAttributeInto(w, { node_id: n.id, key, value });
    }

    try {
      // The FTS index is a derived projection — rebuild it wholesale from the
      // (now-merged) nodes table either way so it stays consistent.
      d.run("DELETE FROM nodes_fts");
      d.run("INSERT INTO nodes_fts(id, title, markdown) SELECT id, title, markdown FROM nodes");
    } catch { /* FTS is best-effort; ignore when the virtual table is unavailable */ }

    d.run("COMMIT");
  } catch (e) {
    d.run("ROLLBACK");
    throw e;
  } finally {
    prepared.forEach((stmt) => stmt.free());
  }
}

// Pure transforms over the Bootstrap state tree. Extracted from useAppData so
// the merge logic (especially the sync-delta application) is unit-testable
// without React. No I/O, no hooks — every function returns a new tree.

import { nodeNeedsBody, type Bootstrap, type ContentNode } from "../api";
import type { SyncDelta, AppliedSyncDelta } from "../localDb";
import { applyTagCatalog } from "../tagProjection";
import { applyCanvasMembershipChange } from "../canvasMemberships";
import { pendingFields } from "./optimisticFields";
import { nodeOf } from "../nodeIndex";
import { isTag } from "@onden/markdown/contract";

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return [...list.filter((x) => x.id !== item.id), item];
}

export function patchNode(data: Bootstrap, nodeId: string, patch: Partial<ContentNode>): Bootstrap {
  const nodes = data.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
  // Tag names are another projection of this node's title. Keep existing tag
  // chips / schema headings consistent through optimistic edits and rollback;
  // the schema pack's independent name is not renamed here (migration 074).
  // A tag's hidden flag (D104) is the same field on both projections.
  const renamedTag = patch.title !== undefined && isTag(nodes.find(n => n.id === nodeId));
  const hiddenTag = patch.hidden !== undefined && !!data.tags?.some(tag => tag.id === nodeId);
  return { ...data, nodes, ...((renamedTag || hiddenTag) && data.tags ? {
    tags: data.tags.map(tag => tag.id !== nodeId ? tag : {
      ...tag, ...(renamedTag ? { name: patch.title! } : {}), ...(hiddenTag ? { hidden: patch.hidden } : {}),
    }),
  } : {}) };
}

export function addNode(data: Bootstrap, node: ContentNode): Bootstrap {
  return { ...data, nodes: [...data.nodes, node] };
}

export function dropNode(data: Bootstrap, nodeId: string): Bootstrap {
  // Cascade the node's dependents exactly like the sync-delta delete
  // (applySyncDelta's nodes.delete branch): otherwise an optimistic delete drops
  // the node but leaves its edges/tasks dangling until a full refresh.
  //   • tasks HOSTED by the node (node_id) AND — when the node IS a task node —
  //     the task whose OWN id matches (node_id-only left a task-node lingering);
  //   • any edge touching the node on either end.
  // (Attributes ride on the node object in this in-memory tree, so they go with
  //  it; the SQLite mirror clears node_attributes in localDb.removeNode.)
  return {
    ...data,
    nodes: data.nodes.filter((n) => n.id !== nodeId),
    ...(data.tags ? { tags: data.tags.filter(tag => tag.id !== nodeId) } : {}),
    tasks: data.tasks.filter((t) => t.node_id !== nodeId && t.id !== nodeId),
    edges: data.edges.filter((e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId),
    ...(data.pointers ? { pointers: data.pointers.filter((p) => p.parent_id !== nodeId && p.target_id !== nodeId) } : {}),
  };
}

export function setNodeAttr(data: Bootstrap, nodeId: string, key: string, value: string): Bootstrap {
  return {
    ...data,
    nodes: data.nodes.map((n) =>
      n.id === nodeId ? { ...n, attrs: { ...(n.attrs ?? {}), [key]: value } } : n,
    ),
  };
}

export function dropNodeAttr(data: Bootstrap, nodeId: string, key: string): Bootstrap {
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const next = { ...(n.attrs ?? {}) };
      delete next[key];
      return { ...n, attrs: next };
    }),
  };
}

/** Which membership list a tag lands in. A class/schema tag (carries a schema)
 *  goes to class_tag_ids; a plain label tag (e.g. #toread) to label_tag_ids.
 *  Mirrors the dual lists the bootstrap projects (see ContentNode). */
function tagMembershipKey(data: Bootstrap, tagId: string): "class_tag_ids" | "label_tag_ids" {
  const tag = nodeOf(data, tagId);
  // schema-bearing tag (tag_schema present) => class membership; otherwise label.
  return tag?.tag_schema || data.tags?.find(candidate => candidate.id === tagId)?.schema_id
    ? "class_tag_ids" : "label_tag_ids";
}

/** Optimistically record a tag application on a node (grow-set, idempotent). */
export function addNodeTag(data: Bootstrap, nodeId: string, tagId: string): Bootstrap {
  const key = tagMembershipKey(data, tagId);
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const cur = n[key] ?? [];
      if (cur.includes(tagId)) return n;
      return { ...n, [key]: [...cur, tagId] };
    }),
  };
}

/** Optimistically drop a tag from a node (both lists — we don't always know
 *  which one held it, and removing from the wrong one is a harmless no-op). */
export function dropNodeTag(data: Bootstrap, nodeId: string, tagId: string): Bootstrap {
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      return {
        ...n,
        class_tag_ids: (n.class_tag_ids ?? []).filter((id) => id !== tagId),
        label_tag_ids: (n.label_tag_ids ?? []).filter((id) => id !== tagId),
      };
    }),
  };
}

/** True when the delta carries nothing to apply (the early-return guard —
 *  MUST include attribute deltas; see useAppData's original comment about
 *  dispatcher-driven attr updates being silently dropped). */
export function isEmptyDelta(delta: SyncDelta): boolean {
  return (
    delta.nodes.upsert.length + delta.nodes.delete.length +
    delta.edges.upsert.length + delta.edges.delete.length +
    delta.tasks.upsert.length + delta.tasks.delete.length +
    delta.attributes.upsert.length + delta.attributes.delete.length +
    (delta.pointers?.upsert.length ?? 0) + (delta.pointers?.delete.length ?? 0) +
    (delta.canvas_memberships?.upsert.length ?? 0) + (delta.canvas_memberships?.delete?.length ?? 0) === 0 &&
    !delta.workspace && delta.tags === undefined && delta.site_config === undefined
  );
}

/** Replace-by-id the way repeated "drop the old row, append the new one" does,
 *  in one pass: rows not in `upserts` keep their order, then the upserted rows
 *  follow in the order of each id's last occurrence. */
function upsertRows<T extends { id: string }>(rows: T[], upserts: readonly T[]): T[] {
  if (upserts.length === 0) return rows;
  const byId = new Map<string, T>();
  for (const row of upserts) { byId.delete(row.id); byId.set(row.id, row); }
  const kept = rows.filter((row) => !byId.has(row.id));
  for (const row of byId.values()) kept.push(row);
  return kept;
}

/** What the store takes of a server copy over the rows it holds: a /api/sync answer (syncDeltaOver), a whole bootstrap
 *  (wholeBootstrapOver), a ?nodes=none refresh (sharedRowsOver), a GET /api/nodes/:id read (serverTruth.readNoteFromServer
 *  through serverCopyOver). Not a block or version restore's row (blockChildWriter, noteHistoryWriter). A copy read before
 *  a write this device was told about never gets here: takeAnswer refuses the whole answer by its position
 *  (lib/data/writePositions.ts). What is left is the edit with no answer yet, which has no position. The one rule for it,
 *  for every kind of row: a field this device has an edit of still waiting for its answer (optimisticFields, the row's
 *  journal `resource`) keeps the value held — the copy may have been read before that edit reached the server (owner
 *  report 2026-11-19: a copy of save 1 replaced the text of save 2 while save 2 was on its way). The journals: a note's
 *  own fields `node:<id>`, its attributes `attribute:<id>`, its tags `membership:<id>` (one field per tag, TagPlace), a
 *  task `task:<id>`, the workspace and its chrome `workspace:<id>`, its site settings `workspace:<id>:config`, a tag in the
 *  tag list `node:<tag>`, a hand-placed graph position `position:<note>`.
 *  `whole`: the copy lists every field of the row, so a missing one is gone (an attribute map, a note's tags, the site
 *  settings, a tag); otherwise a missing field is one the copy does not carry. */
function keepUnanswered<T extends object>(resource: string, incoming: T, current: T | undefined, whole = false): { row: T; held: boolean } {
  let row: T | undefined;
  if (current) for (const key of pendingFields(resource) as ReadonlySet<keyof T & string>) {
    // Field values are JSON (they come from the server): two copies of the same object are not ===.
    const a = incoming[key], b = current[key];
    if ((whole || Object.hasOwn(incoming, key)) && a !== b && JSON.stringify(a) !== JSON.stringify(b)) {
      row ??= { ...incoming };
      // defineProperty: a key named `__proto__` (an attribute's) is data here, not the prototype setter.
      if (Object.hasOwn(current, key)) Object.defineProperty(row, key, { value: b, enumerable: true, writable: true, configurable: true });
      else delete row[key];
    }
  }
  return { row: row ?? incoming, held: !!row };
}

/** What a copy kept, to read again once the edit it was kept from has its answer (syncEngine), so another writer's newer
 *  value in the copy still arrives: `notes` one by one (GET /api/nodes/:id carries a note's fields, attributes and tags);
 *  `rest`, the journals of the other rows, with a bootstrap. */
export type Held = { notes: string[]; rest: string[] };

/** The journals a note row carries (one GET /api/nodes/:id reads them all again). */
export const noteJournals = (id: string) => [`node:${id}`, `attribute:${id}`, `membership:${id}`];

/** Where a tag sits on a note: in its class list (a tag with a schema), its label list, or not on it. */
export type TagPlace = "class" | "label" | undefined;
export const tagPlace = (row: Pick<ContentNode, "class_tag_ids" | "label_tag_ids"> | undefined, tagId: string): TagPlace =>
  row?.class_tag_ids?.includes(tagId) ? "class" : row?.label_tag_ids?.includes(tagId) ? "label" : undefined;

function tagPlaces(row: ContentNode): Record<string, TagPlace> {
  const places: Record<string, TagPlace> = {};
  for (const id of row.label_tag_ids ?? []) places[id] = "label";
  for (const id of row.class_tag_ids ?? []) places[id] = "class";
  return places;
}

/** A note row (keepUnanswered over its three journals). `held`: a field was kept, so the note is read again once its edit
 *  has its answer (syncEngine.readAgainWhenAnswered). */
export function serverCopyOver(incoming: ContentNode, current: ContentNode | undefined): { row: ContentNode; held: boolean } {
  if (!current) return { row: incoming, held: false };
  const id = incoming.id;
  // A slim row's empty text is "not loaded here", not a value this device holds: it is never kept over a copy.
  const own = keepUnanswered(`node:${id}`, incoming, nodeNeedsBody(current) ? { ...current, markdown: incoming.markdown } : current);
  let row = own.row;
  if (own.held) {
    // The row keeps its time (the copy may be older than the edit); a slim answer's body length describes its text, not the one kept.
    row.updated_at = current.updated_at;
    if (row.markdown !== incoming.markdown && Object.hasOwn(incoming, "body_len")) row.body_len = current.body_len ?? (current.markdown ?? "").length;
  }
  const attrs = incoming.attrs && keepUnanswered(`attribute:${id}`, incoming.attrs, current.attrs, true);
  if (attrs && attrs.held) row = { ...row, attrs: attrs.row };
  const places = pendingFields(`membership:${id}`).size && incoming.class_tag_ids ? keepUnanswered(`membership:${id}`, tagPlaces(incoming), tagPlaces(current), true) : undefined;
  if (places?.held) {
    // The lists in the copy's order, a kept tag at the end of the list it is kept in.
    const tagsIn = (place: TagPlace) => Object.keys(places.row).filter((tag) => places.row[tag] === place);
    row = { ...row, class_tag_ids: tagsIn("class"), label_tag_ids: tagsIn("label") };
  }
  return { row, held: own.held || !!attrs?.held || !!places?.held };
}

/** A list a copy carries whole over the store's, row by row (keepUnanswered, each `journal`ed); a row the copy does not
 *  have yet whose edit waits for its answer (a first hand-placed position) stays too. */
function rowsOver<T extends object>(next: T[], prev: T[] | undefined, journal: (row: T) => string, key: (row: T) => string, held: string[], whole = false): T[] {
  if (!prev?.length) return next;
  const before = new Map(prev.map((row) => [key(row), row]));
  const rows = next.map((row) => {
    const kept = keepUnanswered(journal(row), row, before.get(key(row)), whole);
    before.delete(key(row));
    if (kept.held) held.push(journal(row));
    return kept.row;
  });
  for (const row of before.values()) if (pendingFields(journal(row)).size) { rows.push(row); held.push(journal(row)); }
  return rows;
}

/** The workspace-wide rows a copy carries, over the store's: the workspace, its site settings and chrome, the tag list,
 *  the graph's hand-placed positions. Only what `next` has (a ?nodes=none refresh: syncEngine.mergeBootstrapMeta). */
export function sharedRowsOver(prev: Bootstrap, next: Partial<Bootstrap>, held: string[]): Partial<Bootstrap> {
  const out: Partial<Bootstrap> = {};
  const workspace = `workspace:${prev.workspace.id}`;
  const keep = <T extends object>(resource: string, incoming: T, current: T | undefined, whole?: boolean) => {
    const kept = keepUnanswered(resource, incoming, current, whole);
    if (kept.held) held.push(resource);
    return kept.row;
  };
  if (next.workspace) out.workspace = keep(workspace, next.workspace, prev.workspace);
  if (Object.hasOwn(next, "site_config")) out.site_config = next.site_config && keep(`${workspace}:config`, next.site_config, prev.site_config ?? {}, true);
  if (Object.hasOwn(next, "chrome")) out.chrome = keep(workspace, { chrome: next.chrome }, { chrome: prev.chrome }).chrome;
  if (next.tags) out.tags = rowsOver(next.tags, prev.tags, (tag) => `node:${tag.id}`, (tag) => tag.id, held, true);
  if (next.graph_positions) out.graph_positions = rowsOver(next.graph_positions, prev.graph_positions, (p) => `position:${p.nodeId}`, (p) => p.nodeId, held);
  return out;
}

/** A whole bootstrap in place of the store (syncEngine.setWholeBootstrap). */
export function wholeBootstrapOver(prev: Bootstrap, data: Bootstrap): { state: Bootstrap; held: Held } {
  const held: Held = { notes: [], rest: [] };
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const nodes = data.nodes.map((n) => { const copy = serverCopyOver(n, before.get(n.id)); if (copy.held) held.notes.push(n.id); return copy.row; });
  const tasks = rowsOver(data.tasks, prev.tasks, (t) => `task:${t.id}`, (t) => t.id, held.rest);
  return { state: { ...data, nodes, tasks, ...sharedRowsOver(prev, data, held.rest) }, held };
}

/** Apply a /api/sync delta to the in-memory tree. Node/edge/task rows are
 *  whole-row replaces (sync returns the same shape bootstrap does); attribute
 *  deltas patch each node's `attrs` map in place — deletes remove the key,
 *  upserts overwrite. */
export function applySyncDelta(prev: Bootstrap, delta: AppliedSyncDelta): Bootstrap {
  return syncDeltaOver(prev, delta).state;
}

/** applySyncDelta, saying what it kept (syncEngine.applyAndShow reads that again once each edit has its answer). */
export function syncDeltaOver(prev: Bootstrap, delta: AppliedSyncDelta): { state: Bootstrap; held: Held } {
  // `delta` is what the worker's applySync applied, and only an answer read after every write this device had
  // acknowledged gets here (lib/data/writePositions.ts takeAnswer). What an edit still waiting for its answer holds is
  // kept over it (keepUnanswered).
  const held: Held = { notes: [], rest: [] };
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  let nodes = upsertRows(prev.nodes, delta.nodes.upsert.map((n) => { const copy = serverCopyOver(n, before.get(n.id)); if (copy.held) held.notes.push(n.id); return copy.row; }));
  // Node deletes include revocation deletes (a node that left the read set via a
  // permission change — HIGH gap #2). Prune the node's dependent tasks/edges too,
  // so a revoked node leaves no dangling task row or half-edge in memory (mirrors
  // dropNode + the worker's cascade). Backlinks to a revoked node are pruned by
  // the edge's other end becoming unreadable, but a stale edge already in memory
  // must go regardless of which end was revoked.
  const deletedNodeIds = new Set(delta.nodes.delete);
  if (deletedNodeIds.size > 0) nodes = nodes.filter((x) => !deletedNodeIds.has(x.id));
  if (delta.attributes.upsert.length || delta.attributes.delete.length) {
    const attrUpsertByNode = new Map<string, Map<string, string>>();
    for (const a of delta.attributes.upsert) {
      const m = attrUpsertByNode.get(a.node_id) ?? new Map<string, string>();
      m.set(a.key, a.value);
      attrUpsertByNode.set(a.node_id, m);
    }
    const attrDeleteByNode = new Map<string, Set<string>>();
    for (const a of delta.attributes.delete) {
      const s = attrDeleteByNode.get(a.node_id) ?? new Set();
      s.add(a.key);
      attrDeleteByNode.set(a.node_id, s);
    }
    nodes = nodes.map((n) => {
      const adds = attrUpsertByNode.get(n.id);
      const removes = attrDeleteByNode.get(n.id);
      if (!adds && !removes) return n;
      const next = { ...(n.attrs ?? {}) };
      // defineProperty: a key named `__proto__` is data here, not the prototype setter.
      if (adds) for (const [k, v] of adds) Object.defineProperty(next, k, { value: v, enumerable: true, writable: true, configurable: true });
      if (removes) for (const k of removes) delete next[k];
      const kept = keepUnanswered(`attribute:${n.id}`, next, before.get(n.id)?.attrs, true);
      if (kept.held) held.notes.push(n.id);
      return { ...n, attrs: kept.row };
    });
  }
  let edges = upsertRows(prev.edges, delta.edges.upsert);
  if (delta.edges.delete.length > 0) {
    const deletedEdgeIds = new Set(delta.edges.delete);
    edges = edges.filter((x) => !deletedEdgeIds.has(x.id));
  }
  if (deletedNodeIds.size > 0) {
    edges = edges.filter((e) => !deletedNodeIds.has(e.source_node_id) && !deletedNodeIds.has(e.target_node_id));
  }
  let tasks = prev.tasks;
  for (const t of delta.tasks.upsert) {
    const journal = `task:${t.id}`;
    const kept = keepUnanswered(journal, t, pendingFields(journal).size ? prev.tasks.find((x) => x.id === t.id) : undefined);
    if (kept.held) held.rest.push(journal);
    tasks = [...tasks.filter((x) => x.id !== t.id), kept.row];
  }
  for (const id of delta.tasks.delete) tasks = tasks.filter((x) => x.id !== id);
  if (deletedNodeIds.size > 0) {
    // Drop tasks HOSTED by a deleted node (node_id) AND — when the deleted id is
    // itself a TASK node — the task whose OWN id matches (revoked task: it arrives
    // in nodes.delete but must clear the local tasks projection by id, not host).
    tasks = tasks.filter((t) => !(t.node_id !== null && deletedNodeIds.has(t.node_id)) && !deletedNodeIds.has(t.id));
  }
  let pointers = prev.pointers;
  if (pointers && (delta.pointers || deletedNodeIds.size > 0)) {
    for (const p of delta.pointers?.upsert ?? []) pointers = upsertById(pointers, p);
    const removed = new Set(delta.pointers?.delete ?? []);
    pointers = pointers.filter((p) => !removed.has(p.id)
      && !deletedNodeIds.has(p.target_id) && !(p.parent_id && deletedNodeIds.has(p.parent_id)));
  } else if (!pointers && delta.pointers?.upsert.length) {
    pointers = delta.pointers.upsert;
  }
  // The boards each note is on (D98): the worker resolved replace_for into
  // explicit deletes; a deleted note or canvas takes its memberships along.
  const memberships = delta.canvas_memberships || deletedNodeIds.size > 0
    ? applyCanvasMembershipChange(prev.canvas_memberships, delta.canvas_memberships
      ? { upsert: delta.canvas_memberships.upsert, delete: delta.canvas_memberships.delete ?? [] }
      : undefined, deletedNodeIds)
    : prev.canvas_memberships;
  // Own create input can survive revocation of a same-ID remote projection;
  // its old metadata, attributes and relations above must still be removed.
  for (const n of delta.pendingCreations ?? []) nodes = upsertById(nodes, n);
  const tags = applyTagCatalog(prev.tags, delta);
  // The site settings and chrome a delta re-shipped (D119) replace the store's as a bootstrap's do.
  const shared = sharedRowsOver(prev, {
    ...(delta.workspace ? { workspace: delta.workspace } : {}), ...(tags && tags !== prev.tags ? { tags } : {}),
    ...(delta.site_config !== undefined ? { site_config: { ...(delta.site_config ?? {}) }, chrome: delta.chrome ?? null } : {}),
  }, held.rest);
  return { state: {
    ...prev, nodes, edges, tasks, tags, ...(pointers ? { pointers } : {}),
    ...(memberships ? { canvas_memberships: memberships } : {}), ...shared,
  }, held };
}

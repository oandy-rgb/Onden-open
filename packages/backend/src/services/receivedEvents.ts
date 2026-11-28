// What a node's own event log records when it takes another node's change bundle (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.12.5,
// batch 4b): for every unit the merge changed, the event a local write of it records, so this node's clients (the /api/sync delta, History, the day page, the
// tag catalog) see a received change as they see a local one. How each is marked (received, the time it was written, its author, no way back) is
// spine/receivedEvents.ts, the one place. Called by services/receivedDerivation.ts in the bundle's transaction: `readBefore` before the rows are written (what
// a removal no longer shows: an edge's id, a pointer's note, a paragraph's note and tags), `receivedEventsOf` after the rows and their derivation.
//
// RECEIVED_EVENTS below is the map, label by label: what each unit of UNIT_SOURCES (and their JSON keys) records, or why it goes past /api/sync. A label a
// bundle carries without an entry keeps this module from loading (the check below the map). Only a write that won and says its value records an event: a write that lost (a conflict
// kept as a head) and a copy without its value record none (they change nothing a reader shows).
import { isUuid } from "@onden/markdown";
import { db } from "../dbKysely.js";
import type { BundleItem } from "../spine/snapshotSql.js";
import type { ReceivedBundle } from "../spine/receivedDerivation.js";
import type { ReceivedEvent } from "../spine/receivedEvents.js";
import type { Stamp } from "../spine/stampedMerge/index.js";
import { sha256Hex } from "../utils.js";
import type { AttributeSnapshot } from "./eventLog/index.js";
import { paragraphRowsOf, type ParagraphRowState } from "./blockNodes.js";
import { ANCHOR_ROWS_LABEL, anchorsByIds } from "./blockAnchors/index.js";
import { taskNodeIdsAmong } from "./tasksStore.js";
import { CARRIED_LABELS } from "../spine/stampedMerge/index.js";

type Units = ReceivedBundle["units"];
/** A note as the derivation read it, before and after the merge (services/receivedDerivation.ts NoteState). */
type NoteSeen = { live: boolean; space: string | null; hidden: boolean; markdown: string; title: string };

/** How a received unit reaches this node's clients: the events it records (the same kinds a local write of it records), or why it records none. */
type Reach = { events: readonly string[] } | { notThroughSync: string };
/**
 * Label by label (spine/stampedMerge/dbUnits.ts UNIT_SOURCES and its JSON sources). The kinds are those services/sync/delta.ts reads (a node target re-ships
 * its note; EDGE_* its edge; ATTRIBUTE_* their key; NODES_PURGED its ids; SPACE_* and BLOCK_NODE_* move the tag catalog; WORKSPACE_* the workspace row).
 */
const RECEIVED_EVENTS: Readonly<Record<string, Reach>> = {
  workspaces: { events: ["WORKSPACE_UPDATED", "WORKSPACE_TIME_ZONE_CHANGED"] },
  "workspaces.modules_off": { events: ["WORKSPACE_UPDATED"] },
  "workspaces.modules_confirmed": { events: ["WORKSPACE_UPDATED"] },
  spaces: { events: ["SPACE_CREATED", "SPACE_UPDATED", "SPACE_DELETED"] },
  "spaces.capabilities": { events: ["SPACE_UPDATED"] },
  space_members: { events: ["SPACE_MEMBER_SET"] },
  content_nodes: { events: ["NODE_CREATED", "NODE_UPDATED", "NODE_DELETED", "NODE_UNDELETED", "NODE_MOVED_SPACE", "NODE_SPACE_CHANGED", "NODE_HIDDEN_CHANGED", "NODES_PURGED"] },
  "content_nodes.tag_schema": { events: ["TAG_SCHEMA_UPDATED"] },
  node_attributes: { events: ["ATTRIBUTE_SET", "ATTRIBUTE_DELETED"] },
  node_tags: { events: ["TAG_APPLIED", "TAG_REMOVED"] },
  node_edges: { events: ["EDGE_CREATED", "EDGE_DELETED"] },
  note_pointers: { events: ["POINTER_CREATED", "POINTER_DELETED"] },
  node_positions: { events: ["CANVAS_UPDATED", "GRAPH_POSITION_UPDATED"] },
  // the places of a note's anchors are written with its body (one transaction): the note's own NODE_UPDATED re-ships them; a move records nothing locally either
  note_anchor_places: { notThroughSync: "written with the note's body, whose NODE_UPDATED re-ships the note and its anchors (a local move of anchors records no event either)" },
  // the anchor rows: the label is the anchor module's (services/blockAnchors owns its table)
  [ANCHOR_ROWS_LABEL]: { events: ["BLOCK_ANCHOR_CREATED", "BLOCK_ANCHOR_CONFIRMED"] },
  // a row made, changed or gone; and a row the received text hid or showed again (its derived `hidden_at`): REMOVED / RESTORED, as a local save records it
  block_nodes: { events: ["BLOCK_NODE_CREATED", "BLOCK_NODE_UPDATED", "BLOCK_NODE_REMOVED", "BLOCK_NODE_RESTORED"] },
  block_node_tags: { events: ["BLOCK_NODE_UPDATED"] },
  function_refs: { events: ["FUNCTION_REF_ADDED", "FUNCTION_REF_REMOVED", "FUNCTION_REF_CONFIG_CHANGED"] },
  "function_refs.config": { events: ["FUNCTION_REF_CONFIG_CHANGED"] },
  rss_subscriptions: { notThroughSync: "feeds are read by their own routes, never by /api/sync (a local change records no event either)" },
  rss_mutes: { notThroughSync: "a feed's muted words are read by the feed routes, never by /api/sync (a local change records no event either)" },
  external_calendars: { notThroughSync: "calendars are read by their own routes, never by /api/sync (a local change records no event either)" },
  actor_module_settings: { notThroughSync: "a person's settings of a module, read by the module's own routes (a local change records no event either)" },
  // batch 5 (migration 236, 237): what each of the tables that travel since then records
  actor_prefs: { notThroughSync: "a person's preferences, read by /api/me/prefs, never by /api/sync (a local change records no event either: services/actorPrefs.ts)" },
  review_states: { notThroughSync: "a person's review schedule, read by the review routes, never by /api/sync (a grade or a hold records no event either: modules/review/service.ts)" },
  focus_sessions: { notThroughSync: "focus records are read by the tasks module's routes (the day page, the focus clock), never by /api/sync; the writer's FOCUS_* events are its own History of what was done there" },
  actors: { notThroughSync: "people and AI agents are read by the members routes (/api/actors), never by /api/sync; the writer's ACTOR_* events are its own History of what was done there" },
  // History lists a suggestion by its AI_SUGGESTION_CREATED event, a received one as a local one (the inbox leaves a received AI change out: it is reviewed where the AI worked)
  ai_edit_suggestions: { events: ["AI_SUGGESTION_CREATED"] },
  ai_edit_suggestion_items: { notThroughSync: "a decision is read from the items themselves (the note's suggestion bar, the inbox's filter of suggestions still waiting, services/inboxQueue.ts), never by /api/sync; the text an accept wrote arrives as the note's body, whose NODE_UPDATED re-ships it" },
  // a link's binding ships with the note it is written in (delta.ts note_link_bindings, for every re-shipped note): BLOCK_ANCHOR_LINKED on that note re-ships it, as a local link does
  block_link_bindings: { events: ["BLOCK_ANCHOR_LINKED"] },
};

// The map covers exactly what a bundle carries: a label without an entry would be taken silently (its rows written, no client told), an entry of a label
// no bundle carries is a stale one. Checked when the module loads, so a node that cannot tell its clients of a received change does not take bundles at
// all (services/receivedDerivation.ts loads this module, and applyChangeBundle refuses without it: bundle_no_derivation). test/receivedEvents.test.ts loads it.
{
  const missing = CARRIED_LABELS.filter((l) => !Object.hasOwn(RECEIVED_EVENTS, l)), stale = Object.keys(RECEIVED_EVENTS).filter((l) => !CARRIED_LABELS.includes(l));
  const empty = Object.entries(RECEIVED_EVENTS).filter(([, r]) => ("events" in r ? r.events.length === 0 : r.notThroughSync.trim().length < 20)).map(([l]) => l);
  if (missing.length || stale.length || empty.length) {
    throw new Error(`RECEIVED_EVENTS does not match what a bundle carries: no entry for ${missing.join(", ") || "-"}; no such label ${stale.join(", ") || "-"}; no event and no reason for ${empty.join(", ") || "-"}`);
  }
}

/** Every kind the map names: what the writer below may record (it refuses any other, so the map and the code cannot drift apart). */
const DECLARED_KINDS: ReadonlySet<string> = new Set(Object.values(RECEIVED_EVENTS).flatMap((r) => ("events" in r ? r.events : [])));

/** What a removal leaves no trace of after the merge, read before it. */
export type EventsBefore = {
  edges: Map<string, string>;
  pointers: Map<string, string>;
  /** The paragraph rows the bundle names, and every row of the notes whose text it changes (the text hides and shows them). */
  blocks: Map<string, ParagraphRowState>;
  refs: Map<string, string | null>;
  /** Of the notes a bundle may delete for good, the tasks (a client keeps them in its tasks store: NODES_PURGED names them apart). */
  tasks: Set<string>;
};

const SEP = "/";
const rowKeyOf = (item: BundleItem): string | undefined =>
  item.kind === "row" ? item.stamps.find((s) => s.label === item.table)?.rowKey : item.stamp.rowKey;
const rowsOf = (items: readonly BundleItem[], table: string): string[] => [...new Set(items.filter((i) => i.table === table).map(rowKeyOf).filter((k): k is string => !!k))];
const parts = (row: string): string[] => row.split(SEP);

/** The notes whose text a bundle writes (a row item with a stamp of its `body`). */
const textNotesOf = (items: readonly BundleItem[]): string[] =>
  [...new Set(items.filter((i) => i.table === "content_nodes" && i.kind === "row" && i.stamps.some((st) => st.label === "content_nodes" && st.field === "body")).map(rowKeyOf).filter((k): k is string => !!k && isUuid(k)))];

/** Before the bundle's rows are written. `going`: the notes a tombstone may delete for good. */
export async function readBefore(workspaceId: string, items: readonly BundleItem[], going: readonly string[]): Promise<EventsBefore> {
  const edgeKeys = rowsOf(items, "node_edges").map(parts).filter((p) => p.length === 3 && isUuid(p[0]!) && isUuid(p[1]!));
  const edges = edgeKeys.length === 0 ? [] : await db.selectFrom("node_edges").select(["id", "source_node_id", "target_node_id", "edge_type"])
    .where("workspace_id", "=", workspaceId).where("origin", "=", "manual").where("source_node_id", "in", edgeKeys.map((p) => p[0]!)).execute();
  const pointerIds = rowsOf(items, "note_pointers").filter(isUuid);
  const pointers = pointerIds.length === 0 ? [] : await db.selectFrom("note_pointers").select(["id", "target_id"]).where("workspace_id", "=", workspaceId).where("id", "in", pointerIds).execute();
  const blockIds = [...new Set([...rowsOf(items, "block_nodes"), ...rowsOf(items, "block_node_tags").map((r) => parts(r)[0]!)])];
  const textChanged = textNotesOf(items);
  const refIds = rowsOf(items, "function_refs").filter(isUuid);
  const refs = refIds.length === 0 ? [] : await db.selectFrom("function_refs").select(["id", "holder_node_id"]).where("workspace_id", "=", workspaceId).where("id", "in", refIds).execute();
  return {
    edges: new Map(edges.map((e) => [[e.source_node_id, e.target_node_id, e.edge_type].join(SEP), e.id] as const)),
    pointers: new Map(pointers.map((p) => [p.id, p.target_id] as const)),
    blocks: await paragraphRowsOf(workspaceId, { ids: blockIds, notes: textChanged }),
    refs: new Map(refs.map((r) => [r.id, r.holder_node_id] as const)),
    tasks: going.length ? await taskNodeIdsAmong(workspaceId, [...going]) : new Set(),
  };
}

/** The later of two stamps (the time a reader shows, the author it names). */
const later = (a: Stamp | undefined, b: Stamp): Stamp => (!a || b.wall > a.wall || (b.wall === a.wall && b.counter > a.counter) ? b : a);

/** The winning writes the merge stored, by label and row: their fields and the latest stamp. A write that lost, and a copy without its value, are not here. */
type Written = { fields: Set<string>; stamp: Stamp; removed: boolean };
function written(units: Units): Map<string, Map<string, Written>> {
  const out = new Map<string, Map<string, Written>>();
  for (const { address, result } of units) {
    const win = result.unit[0];
    if (!result.write || !win || win.valueless) continue;
    const rows = out.get(address.table) ?? new Map();
    out.set(address.table, rows);
    const at = rows.get(address.row) ?? { fields: new Set<string>(), stamp: win.stamp, removed: false };
    at.fields.add(address.field);
    // the row's own unit: the row is gone after this write (a removed tag, value, arrow)
    if (address.field === "*") at.removed = win.deleted;
    at.stamp = later(at.stamp, win.stamp);
    rows.set(address.row, at);
  }
  return out;
}

type ReceivedNotes = {
  was: ReadonlyMap<string, NoteSeen>;
  now: ReadonlyMap<string, NoteSeen>;
  made: readonly string[];
  gone: readonly string[];
  trashed: readonly string[];
  restored: readonly string[];
  moved: readonly string[];
  hiddenChanged: readonly string[];
};

/** The events of what a bundle changed (after its rows and their derivation are written). */
/** What the events need of the merged state that the derivation reads anyway (services/receivedDerivation.ts: it reads notes and values). */
export type MergedReads = {
  /** The received values as they stand after the merge, encoded as a local write's event names them (eventLog encodeSnapshot), by `node/key`; a value not
   *  there is absent. Made by the derivation BEFORE the purge's sweep: a drawing's snapshot stores its value (on its own connection), as a text does. */
  snapshots: ReadonlyMap<string, AttributeSnapshot>;
  /** Notes' (or tags') titles by id; a note not here is absent. One read for all of them. */
  titles(ids: readonly string[]): Promise<Map<string, string>>;
};

export async function receivedEventsOf(workspaceId: string, units: Units, notes: ReceivedNotes, before: EventsBefore, reads: MergedReads): Promise<ReceivedEvent[]> {
  const w = written(units);
  const rows = (label: string) => w.get(label) ?? new Map<string, Written>();
  // a change that wrote no unit of its own (a note whose space followed its tree, a note restored by its parent): the latest write of the bundle caused it
  let latest: Stamp | undefined;
  for (const r of w.values()) for (const x of r.values()) latest = later(latest, x.stamp);
  if (!latest) return [];
  const out: ReceivedEvent[] = [];
  const add = (type: string, targetType: string, targetId: string, payload: Record<string, unknown>, stamp: Stamp | undefined) => {
    if (!DECLARED_KINDS.has(type)) throw new Error(`a received change records ${type}, which RECEIVED_EVENTS does not name`);
    out.push({ type, targetType, targetId, payload, stamp: stamp ?? latest! });
  };
  // A note put in the trash is written LAST, after every other event of the bundle: the delta re-ships a note for a later node event (an update, an
  // anchor's), and a trashed note re-shipped is no row and no delete, so the tab would keep it (review of PR #1997, round 1, point 4). A local write
  // changes and then deletes, in that order too.
  const trashedLast: ReceivedEvent[] = [];
  const trash = (id: string, stamp: Stamp | undefined) => trashedLast.push({ type: "NODE_DELETED", targetType: "node", targetId: id, payload: {}, stamp: stamp ?? latest! });

  // the workspace and its switches
  const ws = new Map<string, { fields: Set<string>; stamp: Stamp }>();
  for (const label of ["workspaces", "workspaces.modules_off", "workspaces.modules_confirmed"]) for (const [row, x] of rows(label)) {
    const at = ws.get(row) ?? { fields: new Set<string>(), stamp: x.stamp };
    for (const f of x.fields) at.fields.add(label === "workspaces" ? f : label.slice("workspaces.".length));
    at.stamp = later(at.stamp, x.stamp);
    ws.set(row, at);
  }
  for (const [row, x] of ws) {
    if (x.fields.has("time_zone")) add("WORKSPACE_TIME_ZONE_CHANGED", "workspace", row, {}, x.stamp);
    if ([...x.fields].some((f) => f !== "time_zone")) add("WORKSPACE_UPDATED", "workspace", row, { fields: [...x.fields].filter((f) => f !== "time_zone").sort() }, x.stamp);
  }

  // spaces and who is in them
  const spaceIds = [...new Set([...rows("spaces").keys(), ...rows("spaces.capabilities").keys()])].filter(isUuid);
  const spaces = new Map(spaceIds.length === 0 ? [] : (await db.selectFrom("spaces").select(["id", "name", "written_deleted_at"]).where("workspace_id", "=", workspaceId)
    .where("id", "in", spaceIds).execute()).map((s) => [s.id, s] as const));
  for (const id of spaceIds.sort()) {
    const x = rows("spaces").get(id), caps = rows("spaces.capabilities").get(id), s = spaces.get(id);
    const stamp = later(x?.stamp, (caps ?? x)!.stamp);
    if (x?.fields.has("*") && s) add("SPACE_CREATED", "space", id, { name: s.name }, stamp);
    else if (x?.fields.has("deleted") && s?.written_deleted_at) add("SPACE_DELETED", "space", id, {}, stamp);
    else add("SPACE_UPDATED", "space", id, { fields: [...(x?.fields ?? []), ...(caps ? ["capabilities"] : [])].filter((f) => f !== "*").sort() }, stamp);
  }
  const memberRows = [...rows("space_members")].map(([row, x]) => ({ row, x, space: parts(row)[0], actor: parts(row)[1] })).filter((m) => isUuid(m.space ?? "") && isUuid(m.actor ?? ""));
  const permission = new Map<string, string>(memberRows.length === 0 ? [] : (await db.selectFrom("space_members").select(["space_id", "actor_id", "permission"])
    .where("space_id", "in", [...new Set(memberRows.map((m) => m.space!))]).execute()).map((m) => [`${m.space_id}${SEP}${m.actor_id}`, m.permission] as const));
  for (const m of memberRows) add("SPACE_MEMBER_SET", "space", m.space!, { actor_id: m.actor, permission: permission.get(m.row) ?? null }, m.x.stamp);

  // notes
  const noteRows = rows("content_nodes");
  const ids = [...new Set([...noteRows.keys(), ...notes.made, ...notes.trashed, ...notes.restored, ...notes.moved, ...notes.hiddenChanged])].filter(isUuid).sort();
  const [made, trashed, restored, moved, hiddenChanged, gone] = [notes.made, notes.trashed, notes.restored, notes.moved, notes.hiddenChanged, notes.gone].map((l) => new Set(l));
  const purged = new Map<string, string[]>();
  for (const id of notes.gone) {
    const space = notes.was.get(id)?.space ?? null;
    if (space) purged.set(space, [...(purged.get(space) ?? []), id]);
  }
  for (const id of ids) {
    const x = noteRows.get(id), now = notes.now.get(id);
    if (!now) continue; // deleted for good: NODES_PURGED below
    // the text is stored already (services/receivedDerivation.ts storeReceivedTexts, before the purge's sweep): the event names its hash
    const bodyHash = x?.fields.has("body") || made.has(id) ? sha256Hex(now.markdown) : null;
    if (made.has(id)) {
      add("NODE_CREATED", "node", id, { title: now.title, body_hash: bodyHash }, x?.stamp);
      // made and put in the trash before this node heard of it: a client that saw the creation is told it is gone, as the two local writes tell it
      if (!now.live) trash(id, x?.stamp);
      continue;
    }
    // Every field of the note the bundle wrote records an event, as the writer's own log has one for it (a tab re-ships the note for it), whether or not it
    // moved the note's state HERE: put in the trash and taken out again on the other node, the written `deleted` is what this node had, and without an event
    // a tab of this node was never told the note while a tab of the writer was (receivedDerivation.integration.test.ts, found by seed 380206382). A trash, a
    // restore, a move and a hide that moved the state are told by their own kind; a written `deleted`, `space` or `hidden` that did not is named in
    // NODE_UPDATED's fields, except a note in the trash here, which is told it is gone (the delete written last: a re-shipped trashed note is no row).
    const toldByKind: Readonly<Record<string, boolean>> = {
      "*": true, deleted: trashed.has(id) || restored.has(id) || !now.live, space: moved.has(id), hidden: hiddenChanged.has(id),
    };
    if (trashed.has(id) || (x?.fields.has("deleted") && !now.live)) trash(id, x?.stamp);
    if (restored.has(id)) add("NODE_UNDELETED", "node", id, {}, x?.stamp);
    if (moved.has(id)) add(x?.fields.has("space") ? "NODE_MOVED_SPACE" : "NODE_SPACE_CHANGED", "node", id, { from: notes.was.get(id)?.space ?? null, to: now.space }, x?.stamp);
    if (hiddenChanged.has(id)) add("NODE_HIDDEN_CHANGED", "node", id, { hidden: now.hidden }, x?.stamp);
    const fields = [...(x?.fields ?? [])].filter((f) => !toldByKind[f]).sort();
    if (fields.length) add("NODE_UPDATED", "node", id, { fields, ...(bodyHash ? { body_hash: bodyHash } : {}) }, x?.stamp);
  }
  for (const [space, gone] of [...purged].sort(([a], [b]) => (a < b ? -1 : 1))) {
    add("NODES_PURGED", "space", space, { count: gone.length, node_ids: gone.filter((id) => !before.tasks.has(id)), task_ids: gone.filter((id) => before.tasks.has(id)) }, undefined);
  }
  for (const [id, x] of rows("content_nodes.tag_schema")) if (notes.now.has(id) || isUuid(id)) add("TAG_SCHEMA_UPDATED", "tag", id, { keys: [...x.fields].map((f) => f.replace(/^key:/, "")).sort() }, x.stamp);
  const held = (id: string | undefined): id is string => !!id && isUuid(id) && !gone.has(id);

  // values, tags, arrows, pointers, places on a board: one read per table for the whole bundle
  const valueRows = [...rows("node_attributes")].map(([row, x]) => ({ row, x, nodeId: row.slice(0, row.indexOf(SEP)), key: row.slice(row.indexOf(SEP) + 1) })).filter((v) => held(v.nodeId));
  for (const v of valueRows) {
    const a = reads.snapshots.get(v.row);
    if (a) add("ATTRIBUTE_SET", "node", v.nodeId, { key: v.key, ...a }, v.x.stamp);
    else add("ATTRIBUTE_DELETED", "node", v.nodeId, { key: v.key }, v.x.stamp);
  }
  const tagRows = [...rows("node_tags")].map(([row, x]) => ({ x, node: parts(row)[0], tag: parts(row)[1] })).filter((t) => held(t.node) && isUuid(t.tag ?? ""));
  const tagNames = await reads.titles([...new Set(tagRows.map((t) => t.tag!))]);
  for (const t of tagRows) add(t.x.removed ? "TAG_REMOVED" : "TAG_APPLIED", "node", t.node!, { tag_id: t.tag, tag_name: tagNames.get(t.tag!) ?? null }, t.x.stamp);
  const arrowRows = [...rows("node_edges")].map(([row, x]) => ({ row, x, p: parts(row) })).filter((e) => e.p.length === 3 && isUuid(e.p[0]!) && isUuid(e.p[1]!));
  const arrows = new Map(arrowRows.length === 0 ? [] : (await db.selectFrom("node_edges").select(["id", "source_node_id", "target_node_id", "edge_type"]).where("workspace_id", "=", workspaceId)
    .where("origin", "=", "manual").where("source_node_id", "in", [...new Set(arrowRows.map((e) => e.p[0]!))]).execute()).map((e) => [[e.source_node_id, e.target_node_id, e.edge_type].join(SEP), e.id] as const));
  for (const e of arrowRows) {
    const [source, target, type] = e.p as [string, string, string];
    // a removed arrow is named by the id it had (read before the merge removed it: delta.ts deletes by id)
    if (arrows.has(e.row)) add("EDGE_CREATED", "edge", arrows.get(e.row)!, { source_node_id: source, target_node_id: target, edge_type: type }, e.x.stamp);
    else if (before.edges.has(e.row)) add("EDGE_DELETED", "edge", before.edges.get(e.row)!, {}, e.x.stamp);
  }
  const pointerIds = [...rows("note_pointers").keys()].filter(isUuid);
  const pointers = new Map(pointerIds.length === 0 ? [] : (await db.selectFrom("note_pointers").select(["id", "target_id", "parent_id"]).where("workspace_id", "=", workspaceId)
    .where("id", "in", pointerIds).execute()).map((p) => [p.id, p] as const));
  for (const id of pointerIds) {
    const p = pointers.get(id), x = rows("note_pointers").get(id)!;
    if (p) add("POINTER_CREATED", "node", p.target_id, { pointer_id: id, parent_id: p.parent_id }, x.stamp);
    else if (held(before.pointers.get(id))) add("POINTER_DELETED", "node", before.pointers.get(id)!, { pointer_id: id }, x.stamp);
  }
  for (const [row, x] of rows("node_positions")) {
    const node = parts(row)[0], surface = row.slice(row.indexOf(SEP) + 1);
    if (!held(node)) continue;
    if (surface === "graph") add("GRAPH_POSITION_UPDATED", "node", node, { fields: ["graph_position"] }, x.stamp);
    else if (held(surface)) add("CANVAS_UPDATED", "canvas", surface, { fields: ["cards"], node_id: node }, x.stamp);
  }

  // anchors and paragraph rows: about their note, as a local save records them
  const anchors = await anchorsByIds(workspaceId, [...rows(ANCHOR_ROWS_LABEL).keys()]);
  for (const [id, x] of rows(ANCHOR_ROWS_LABEL)) {
    const note = anchors.get(id)?.noteId;
    if (note && x.fields.has("*") && !x.removed) add("BLOCK_ANCHOR_CREATED", "node", note, { anchor_id: id, how: "received" }, x.stamp);
    else if (note) add("BLOCK_ANCHOR_CONFIRMED", "node", note, { anchor_id: id, how: "received" }, x.stamp);
    // a removed anchor: its note re-ships with the body that removed it
  }
  const blockIds = [...new Set([...rows("block_nodes").keys(), ...[...rows("block_node_tags").keys()].map((r) => parts(r)[0]!)])].filter(isUuid).sort();
  const textNotes = [...new Set([...before.blocks.values()].map((b) => b.note))];
  const blocks = await paragraphRowsOf(workspaceId, { ids: blockIds, notes: textNotes });
  const tagStamp = new Map<string, Stamp>();
  for (const [row, t] of rows("block_node_tags")) tagStamp.set(parts(row)[0]!, later(tagStamp.get(parts(row)[0]!), t.stamp));
  for (const id of blockIds) {
    const x = rows("block_nodes").get(id), was = before.blocks.get(id), now = blocks.get(id);
    const t = tagStamp.get(id);
    const stamp = t ? later(x?.stamp, t) : x?.stamp;
    if (!now) { if (was && held(was.note)) add("BLOCK_NODE_REMOVED", "node", was.note, { block_node_id: id }, stamp); continue; }
    if (!held(now.note)) continue;
    if (!was) { add("BLOCK_NODE_CREATED", "node", now.note, { block_node_id: id, tag_ids: now.tags }, stamp); continue; }
    // a paragraph taken back (its standing-alone child cleared): it counts for its tags again (tagCatalog.blockEventTagUse)
    const reattached = x?.fields.has("detached") && now.detached === null;
    add("BLOCK_NODE_UPDATED", "node", now.note, { block_node_id: id, before: { tag_ids: was.tags }, after: { tag_ids: now.tags }, ...(reattached ? { reattached: true } : {}) }, stamp);
  }

  // a paragraph the received text hid or showed again: only its derived `hidden_at` moved (no unit of it), as a local save records it (BLOCK_NODE_REMOVED /
  // RESTORED): it leaves or rejoins its tags' counts, so the delta re-ships the tag catalog (review of PR #1997, round 1, point 5)
  const named = new Set(blockIds);
  for (const [id, now] of [...blocks].sort(([p], [q]) => (p < q ? -1 : 1))) {
    const was = before.blocks.get(id);
    if (named.has(id) || !was || was.hidden === now.hidden || !held(now.note)) continue;
    add(now.hidden ? "BLOCK_NODE_REMOVED" : "BLOCK_NODE_RESTORED", "node", now.note, { block_node_id: id, kept: true }, noteRows.get(now.note)?.stamp);
  }

  // a suggestion made on another node: History lists it by this event (services/aiSuggestions.ts writes the same payload)
  const suggestionIds = [...rows("ai_edit_suggestions")].filter(([, x]) => x.fields.has("*") && !x.removed).map(([id]) => id).filter(isUuid).sort();
  const suggestions = suggestionIds.length === 0 ? [] : await db.selectFrom("ai_edit_suggestions as s")
    .leftJoin("ai_edit_suggestion_items as i", "i.suggestion_id", "s.id")
    .select(["s.id", "s.node_id", "s.agent_actor_id", "s.session_id", "i.kind"])
    .where("s.workspace_id", "=", workspaceId).where("s.id", "in", suggestionIds).execute();
  for (const id of suggestionIds) {
    const of = suggestions.filter((r) => r.id === id), s = of[0];
    if (!s || !held(s.node_id)) continue;
    const kinds: Record<string, number> = {};
    for (const r of of) if (r.kind) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    add("AI_SUGGESTION_CREATED", "node", s.node_id, {
      suggestion_id: id, agent_actor_id: s.agent_actor_id, ...(s.session_id ? { session_id: s.session_id } : {}), item_count: Object.values(kinds).reduce((n, k) => n + k, 0), kinds,
    }, rows("ai_edit_suggestions").get(id)!.stamp);
  }

  // a link's binding: about the note it is written in (services/blockAnchors recordLinkBound writes the same payload). A binding goes only with its note
  // (no local write removes one otherwise): a removed one is told by its note's own events.
  const bindingRows = [...rows("block_link_bindings")].filter(([, x]) => !x.removed).map(([row, x]) => ({ x, note: row.slice(0, row.indexOf(SEP)), text: row.slice(row.indexOf(SEP) + 1) }))
    .filter((b) => held(b.note));
  const bindings = bindingRows.length === 0 ? [] : await db.selectFrom("block_link_bindings").select(["note_id", "link_text", "anchor_id"])
    .where("workspace_id", "=", workspaceId).where("note_id", "in", [...new Set(bindingRows.map((b) => b.note))]).execute();
  const boundAnchor = new Map(bindings.map((b) => [`${b.note_id}${SEP}${b.link_text}`, b.anchor_id] as const));
  const linkedAnchors = await anchorsByIds(workspaceId, [...new Set([...boundAnchor.values()].filter((a): a is string => !!a))]);
  for (const b of bindingRows) {
    const anchor = boundAnchor.get(`${b.note}${SEP}${b.text}`);
    if (anchor) add("BLOCK_ANCHOR_LINKED", "node", b.note, { anchor_id: anchor, target_note_id: linkedAnchors.get(anchor)?.noteId ?? null }, b.x.stamp);
  }

  // function references (a review card, a view): about the note that holds them
  const refIds = [...new Set([...rows("function_refs").keys(), ...rows("function_refs.config").keys()])].filter(isUuid).sort();
  const refs = new Map(refIds.length === 0 ? [] : (await db.selectFrom("function_refs").select(["id", "holder_node_id", "holder_block_id"]).where("workspace_id", "=", workspaceId)
    .where("id", "in", refIds).execute()).map((r) => [r.id, r] as const));
  const holderBlocks = await paragraphRowsOf(workspaceId, { ids: [...refs.values()].map((r) => r.holder_block_id).filter((b): b is string => !!b && !blocks.has(b)) });
  for (const id of refIds) {
    const x = rows("function_refs").get(id), c = rows("function_refs.config").get(id), r = refs.get(id);
    const stamp = later(x?.stamp, (c ?? x)!.stamp);
    const block = r?.holder_block_id ? blocks.get(r.holder_block_id) ?? holderBlocks.get(r.holder_block_id) : undefined;
    const holder = r ? r.holder_node_id ?? block?.note ?? null : before.refs.get(id);
    if (!held(holder ?? undefined)) continue;
    if (!r) add("FUNCTION_REF_REMOVED", "node", holder!, { ref_id: id }, stamp);
    else if (x?.fields.has("*")) add("FUNCTION_REF_ADDED", "node", holder!, { ref_id: id }, stamp);
    else add("FUNCTION_REF_CONFIG_CHANGED", "node", holder!, { ref_id: id }, stamp);
  }
  return [...out, ...trashedLast];
}

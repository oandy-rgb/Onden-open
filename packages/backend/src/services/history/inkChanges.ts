// What drawing saves changed, for History (the sibling of the text changes in noteVersions.ts / activity.ts).
//
// A note keeps up to two drawings, each a whole page in its own attribute: its handwriting page (`ink_data`) and
// its whiteboard's pen layer (`board_ink`). Everything here takes the drawing's `kind` (@onden/markdown InkKind)
// and runs the same query for both. A drawing's versions are rows of note_versions (storedVersions.ts), one unit per
// drawing (`ink_data`, `board_ink`, `note_ink`; the saves of a board that migration 172 moved out of `ink_data` were
// filed under `board_ink` when migration 220 minted them). A version's `content_hash` names the drawing, in `blobs` or in
// the note's chunks (inkChunks.ts). A version is addressed by its `version_key`; the number of an event of this node
// still works for one release and is looked up through note_version_events. Nothing is stored as a difference:
// like text, History compares two stored versions when it reads (@onden/markdown/ink inkChangeSummary).
// Only the counts are sent with a list; the two drawings behind a row are fetched when someone opens it
// (inkChangeValues), after canReadNode, so an unreadable note yields no drawing.

import { INK_KIND_ATTR, inkChangeSummary, type InkKind } from "@onden/markdown/ink";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { shownAuthorKind, shownAuthorName } from "../authorName.js";
import type { ActorCtx } from "../../types.js";
import { canReadNode } from "../readPolicy.js";
import { readInkValues } from "../inkChunks.js";
import { setNodeAttribute, type AttributeWriteResult } from "../attributeWrites.js";
import { sqlDayStart } from "../../localDay.js";
import { EDIT_VERSION_SQL, STATE_VERSION_SQL } from "./bodyEvents.js";
import { resolveVersionKey } from "../../spine/noteVersions.js";
import { AUTHOR_REF, ELSEWHERE, VERSION_ORDER_ASC, VERSION_ORDER_DESC, authorColumns } from "./storedVersions.js";
import { actorKindOf } from "./noteVersions.js";
import type { DayInkChange, InkEdit } from "@onden/contract";

const STATE = sql.raw(STATE_VERSION_SQL);
/** An edit someone made (not a baseline: the drawing a note held when its history began is no day's edit; the event reader never had one). */
const EDIT = sql.raw(EDIT_VERSION_SQL);

/** The drawing each version left, by `version_key`: "" for a version that removed the drawing. A version whose drawing is no longer stored is
 *  missing from the map. `unit` is the drawing's attribute (`INK_KIND_ATTR[kind]`); a key names a version only inside one note and unit. */
async function drawingsOf(workspaceId: string, unit: string, wanted: Array<{ nodeId: string; key: string }>): Promise<Map<string, string>> {
  if (wanted.length === 0) return new Map();
  const rows = (await sql<{ node_id: string; key: string; removed: boolean; ref: string | null }>`
    SELECT v.note_id::text AS node_id, v.version_key AS key, v.kind = 'removed' AS removed, v.content_hash AS ref
      FROM note_versions v
      JOIN unnest(${wanted.map((w) => w.nodeId)}::uuid[], ${wanted.map((w) => w.key)}::text[]) AS x(note_id, version_key) ON x.note_id = v.note_id AND x.version_key = v.version_key
     WHERE v.workspace_id = ${workspaceId}::uuid AND v.unit = ${unit}`.execute(db)).rows;
  // The text of a ref: a `blobs` row or the note's chunks (inkChunks.ts); one read per note.
  const refsOf = new Map<string, string[]>();
  for (const r of rows) if (!r.removed && r.ref) refsOf.set(r.node_id, [...(refsOf.get(r.node_id) ?? []), r.ref]);
  const texts = new Map<string, string>();
  for (const [nodeId, refs] of refsOf) for (const [ref, text] of await readInkValues(workspaceId, nodeId, refs)) texts.set(`${nodeId}:${ref}`, text);
  return new Map(rows.flatMap((r) => {
    if (r.removed) return [[`${r.node_id}:${r.key}`, ""] as const];
    const value = r.ref ? texts.get(`${r.node_id}:${r.ref}`) : undefined;
    return value ? [[`${r.node_id}:${r.key}`, value] as const] : [];
  }));
}

/** For each (note, day): what the day changed in the note's drawing, from the last version before the day began
 *  (none: nothing was drawn yet) to the last version of the day. Keyed `day:nodeId`; absent when the day's
 *  drawing is the same, or either drawing is no longer stored. The caller has already cut the notes to
 *  those its actor can read (activity.ts). */
export async function dayInkChanges(workspaceId: string, pairs: Array<{ nodeId: string; day: string }>, kind: InkKind): Promise<Map<string, DayInkChange>> {
  if (pairs.length === 0) return new Map();
  const unit = INK_KIND_ATTR[kind];
  const ends = (await sql<{ node_id: string; day: string; pre: string | null; post: string | null }>`
    SELECT x.node_id, x.day,
           (SELECT v.version_key FROM note_versions v WHERE v.workspace_id = ${workspaceId}::uuid AND v.note_id = x.node_id::uuid AND v.unit = ${unit} AND ${EDIT}
               AND v.at::timestamptz < ${sql.raw(sqlDayStart("x.day::date"))} ORDER BY ${VERSION_ORDER_DESC} LIMIT 1) AS pre,
           (SELECT v.version_key FROM note_versions v WHERE v.workspace_id = ${workspaceId}::uuid AND v.note_id = x.node_id::uuid AND v.unit = ${unit} AND ${EDIT}
               AND v.at::timestamptz < ${sql.raw(sqlDayStart("x.day::date + 1"))} ORDER BY ${VERSION_ORDER_DESC} LIMIT 1) AS post
      FROM unnest(${pairs.map((p) => p.nodeId)}::text[], ${pairs.map((p) => p.day)}::text[]) AS x(node_id, day)`.execute(db)).rows;
  const changed = ends.filter((r): r is typeof r & { post: string } => r.post !== null && r.post !== r.pre);
  const drawings = await drawingsOf(workspaceId, unit, changed.flatMap((r) => (r.pre ? [{ nodeId: r.node_id, key: r.pre }, { nodeId: r.node_id, key: r.post }] : [{ nodeId: r.node_id, key: r.post }])));
  const out = new Map<string, DayInkChange>();
  for (const r of changed) {
    const after = drawings.get(`${r.node_id}:${r.post}`);
    const before = r.pre ? drawings.get(`${r.node_id}:${r.pre}`) : null;
    if (after === undefined || before === undefined) continue;
    const summary = inkChangeSummary(before, after);
    if (summary.added + summary.erased > 0) out.set(`${r.day}:${r.node_id}`, { ...summary, before_event: r.pre, after_event: r.post });
  }
  return out;
}


/** Edits listed for one note, newest first. */
const INK_EDIT_LIMIT = 20;

/** One note's edits of one drawing, newest first: a run of versions by one author within 5 minutes of each other is one
 *  edit, with what it drew and erased against the drawing before it. Removing a drawing is an edit of its own, and so is the
 *  save after it. An edit that changed nothing countable (the same strokes, or a drawing no longer stored) is left out. null when
 *  `actor` cannot read the note (indistinguishable from a missing one). */
export async function listInkEdits(workspaceId: string, actor: ActorCtx, nodeId: string, kind: InkKind): Promise<InkEdit[] | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  const unit = INK_KIND_ATTR[kind];
  const sessions = (await sql<{ first_id: string; last_id: string; last_at: Date; actor_name: string | null; author_kind: string; row_type: string | null; elsewhere: boolean; saves: number }>`
    WITH vs AS (
      SELECT v.version_key, v.kind, v.at::timestamptz AS at, v.author_kind, v.author_id, ${AUTHOR_REF} AS author_ref, v.recorded_by, ${ELSEWHERE} AS elsewhere,
             row_number() OVER (ORDER BY ${VERSION_ORDER_ASC}) AS rk
        FROM note_versions v WHERE v.workspace_id = ${workspaceId}::uuid AND v.note_id = ${nodeId}::uuid AND v.unit = ${unit} AND ${EDIT}
    ),
    marked AS (SELECT vs.*, CASE WHEN lag(at) OVER w IS NULL OR at - lag(at) OVER w > interval '5 minutes'
                                   OR author_kind IS DISTINCT FROM lag(author_kind) OVER w OR author_id IS DISTINCT FROM lag(author_id) OVER w
                                   OR author_ref IS DISTINCT FROM lag(author_ref) OVER w
                                   OR recorded_by IS DISTINCT FROM lag(recorded_by) OVER w
                                   OR kind = 'removed' OR lag(kind) OVER w = 'removed' THEN 1 ELSE 0 END AS boundary
                 FROM vs WINDOW w AS (ORDER BY rk)),
    numbered AS (SELECT *, sum(boundary) OVER (ORDER BY rk) AS edit_no FROM marked)
    SELECT (array_agg(n.version_key ORDER BY n.rk))[1] AS first_id,
           (array_agg(n.version_key ORDER BY n.rk DESC))[1] AS last_id,
           max(n.at) AS last_at, max(a.name) AS actor_name, (array_agg(n.author_kind ORDER BY n.rk DESC))[1] AS author_kind, (array_agg(a.type ORDER BY n.rk DESC))[1] AS row_type, (array_agg(n.elsewhere ORDER BY n.rk DESC))[1] AS elsewhere, count(*)::int AS saves
      FROM numbered n LEFT JOIN actors a ON a.id::text = n.author_ref
     GROUP BY n.edit_no ORDER BY n.edit_no`.execute(db)).rows;
  // Each edit starts from where the one before it ended; the oldest from nothing.
  const edits = sessions.map((s, i) => ({ ...s, before_event: i > 0 ? sessions[i - 1]!.last_id : null })).slice(-INK_EDIT_LIMIT).reverse();
  const drawings = await drawingsOf(workspaceId, unit, edits.flatMap((e) => (e.before_event ? [{ nodeId, key: e.before_event }, { nodeId, key: e.last_id }] : [{ nodeId, key: e.last_id }])));
  const out: InkEdit[] = [];
  for (const e of edits) {
    const after = drawings.get(`${nodeId}:${e.last_id}`);
    const before = e.before_event ? drawings.get(`${nodeId}:${e.before_event}`) : null;
    if (after === undefined || before === undefined) continue;
    const summary = inkChangeSummary(before, after);
    if (summary.added + summary.erased === 0) continue;
    const { actor_type, author_row_type: kindRow } = authorColumns(e.author_kind);
    const author_row_type = e.row_type ?? kindRow;
    out.push({
      ...summary, id: e.last_id, before_event: e.before_event, after_event: e.last_id, changed_at: e.last_at.toISOString(),
      actor_name: shownAuthorName(author_row_type, e.actor_name), actor_kind: shownAuthorKind(author_row_type, actorKindOf(actor_type)), saves: e.saves,
      ...(e.elsewhere ? { on_another_device: true as const } : {}),
    });
  }
  return out;
}

/** The two drawings behind one change (`beforeEvent` none = nothing drawn yet), for the picture. Each is named by the key of a version of
 *  this note's drawing (or the number of an event of this node: the older spelling). null when `actor` cannot read the note, a name is not a
 *  version of this drawing, or its drawing is no longer stored. */
export async function inkChangeValues(
  workspaceId: string, actor: ActorCtx, nodeId: string, kind: InkKind, beforeEvent: string | null, afterEvent: string,
): Promise<{ before: string | null; after: string } | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  const unit = INK_KIND_ATTR[kind];
  const afterKey = await resolveVersionKey(nodeId, unit, afterEvent);
  const beforeKey = beforeEvent === null ? null : await resolveVersionKey(nodeId, unit, beforeEvent);
  if (afterKey === null || (beforeEvent !== null && beforeKey === null)) return null;
  const drawings = await drawingsOf(workspaceId, unit, beforeKey ? [{ nodeId, key: beforeKey }, { nodeId, key: afterKey }] : [{ nodeId, key: afterKey }]);
  const after = drawings.get(`${nodeId}:${afterKey}`);
  const before = beforeKey ? drawings.get(`${nodeId}:${beforeKey}`) : null;
  return after === undefined || before === undefined ? null : { before, after };
}

/** Put one drawing back as it was in the version `versionId` (a key, or the number of an event of this node): a new write of the attribute that kind lives in
 *  (`ink_data` for "handwriting", `board_ink` for "board"; never the other one), under the actor's current write
 *  authority, recorded as an ordinary ATTRIBUTE_SET so it shows in History and can be undone like any edit. The
 *  stored drawing is replaced whole (no merge: restoring is a decision to take later strokes out). A save of the
 *  board from before migration 172 (stored under `ink_data`) is restored into `board_ink`.
 *  null when `actor` cannot read the note, `versionId` is not a version of this kind of this note, or its drawing is
 *  no longer stored (or the version removed the drawing: there is nothing to put back). */
export async function restoreInkVersion(
  workspaceId: string, actor: ActorCtx, nodeId: string, kind: InkKind, versionId: string,
): Promise<AttributeWriteResult | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  const unit = INK_KIND_ATTR[kind];
  const key = await resolveVersionKey(nodeId, unit, versionId);
  if (key === null) return null;
  const value = (await drawingsOf(workspaceId, unit, [{ nodeId, key }])).get(`${nodeId}:${key}`);
  if (!value) return null;
  return setNodeAttribute({ workspaceId, actor, nodeId, attribute: { key: unit, value, value_type: "text" } });
}

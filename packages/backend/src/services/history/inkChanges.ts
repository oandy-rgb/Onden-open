// What drawing saves changed, for History (the sibling of the text changes in noteVersions.ts / activity.ts).
//
// A note keeps up to two drawings, each a whole page in its own attribute: its handwriting page (`ink_data`) and
// its whiteboard's pen layer (`board_ink`). Everything here takes the drawing's `kind` (@onden/markdown InkKind)
// and runs the same query for both; bodyEvents.ts inkEventSql says which events belong to which, including the
// saves of a board that migration 172 moved out of `ink_data`. Each save is an ATTRIBUTE_SET event whose
// `value_ref` names the drawing in `blobs` (eventLog/attributeSnapshot.ts). Nothing is stored as a difference:
// like text, History compares two stored versions when it reads (@onden/markdown/ink inkChangeSummary).
// Only the counts are sent with a list; the two drawings behind a row are fetched when someone opens it
// (inkChangeValues), after canReadNode, so an unreadable note yields no drawing.

import { INK_KIND_ATTR, inkChangeSummary, type InkKind } from "@onden/markdown/ink";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { sqlDayStart } from "../../localDay.js";
import { canReadNode } from "../readPolicy.js";
import { setNodeAttribute, type AttributeWriteResult } from "../attributeWrites.js";
import { inkEventSql, lastInkEventBeforeSql, startsNewEditSql } from "./bodyEvents.js";
import { actorKindOf } from "./noteVersions.js";
import type { DayInkChange, InkEdit } from "@onden/contract";

/** Event ids are bigint in the log; the API carries them as text. */
const EVENT_ID = /^\d{1,18}$/;

/** The drawing each save left, by event id: "" for a save that removed the drawing. A save whose drawing
 *  is no longer stored is missing from the map. */
async function drawingsOf(workspaceId: string, eventIds: string[]): Promise<Map<string, string>> {
  if (eventIds.length === 0) return new Map();
  const rows = await q<{ id: string; deleted: boolean; value: string | null }>(
    `SELECT e.id::text AS id, e.event_type = 'ATTRIBUTE_DELETED' AS deleted, COALESCE(b.content, e.payload->>'value') AS value
       FROM domain_events e
  LEFT JOIN blobs b ON b.hash = e.payload->>'value_ref'
      WHERE e.workspace_id = $1 AND e.id = ANY($2::bigint[]) AND ${inkEventSql("e")}`,
    [workspaceId, [...new Set(eventIds)]],
  );
  return new Map(rows.rows.flatMap((r) => (r.deleted ? [[r.id, ""] as const] : r.value ? [[r.id, r.value] as const] : [])));
}

/** For each (note, day): what the day changed in the note's drawing, from the last save before the day began
 *  (none: nothing was drawn yet) to the last save of the day. Keyed `day:nodeId`; absent when the day's
 *  drawing is the same, or either drawing is no longer stored. The caller has already cut the notes to
 *  those its actor can read (activity.ts). */
export async function dayInkChanges(workspaceId: string, pairs: Array<{ nodeId: string; day: string }>, kind: InkKind): Promise<Map<string, DayInkChange>> {
  if (pairs.length === 0) return new Map();
  const ends = await q<{ node_id: string; day: string; pre: string | null; post: string | null }>(
    `SELECT x.node_id, x.day,
            ${lastInkEventBeforeSql(kind, "$1", "x.node_id", { time: sqlDayStart("x.day::date") })} AS pre,
            ${lastInkEventBeforeSql(kind, "$1", "x.node_id", { time: sqlDayStart("x.day::date + 1") })} AS post
       FROM unnest($2::text[], $3::text[]) AS x(node_id, day)`,
    [workspaceId, pairs.map((p) => p.nodeId), pairs.map((p) => p.day)],
  );
  const changed = ends.rows.filter((r): r is typeof r & { post: string } => r.post !== null && r.post !== r.pre);
  const drawings = await drawingsOf(workspaceId, changed.flatMap((r) => (r.pre ? [r.pre, r.post] : [r.post])));
  const out = new Map<string, DayInkChange>();
  for (const r of changed) {
    const after = drawings.get(r.post);
    const before = r.pre ? drawings.get(r.pre) : null;
    if (after === undefined || before === undefined) continue;
    const summary = inkChangeSummary(before, after);
    if (summary.added + summary.erased > 0) out.set(`${r.day}:${r.node_id}`, { ...summary, before_event: r.pre, after_event: r.post });
  }
  return out;
}


/** Edits listed for one note, newest first. */
const INK_EDIT_LIMIT = 20;

/** One note's edits of one drawing, newest first: a run of saves by one actor within 5 minutes of each other is one
 *  edit (startsNewEditSql), with what it drew and erased against the drawing before it. An edit that changed
 *  nothing countable (the same strokes, or a drawing no longer stored) is left out. null when `actor`
 *  cannot read the note (indistinguishable from a missing one). */
export async function listInkEdits(workspaceId: string, actor: ActorCtx, nodeId: string, kind: InkKind): Promise<InkEdit[] | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  const sessions = await q<{ first_id: string; last_id: string; last_at: Date; actor_name: string | null; actor_type: string; saves: number }>(
    `WITH saves AS (
       SELECT e.id, e.actor_id, e.actor_type, e.event_type, e.created_at
         FROM domain_events e WHERE e.workspace_id = $1 AND e.target_id = $2 AND ${inkEventSql("e", kind)}
     ),
     marked AS (SELECT *, CASE WHEN ${startsNewEditSql("w")} THEN 1 ELSE 0 END AS boundary FROM saves WINDOW w AS (ORDER BY created_at, id)),
     numbered AS (SELECT *, sum(boundary) OVER (ORDER BY created_at, id) AS edit_no FROM marked)
     SELECT (array_agg(n.id ORDER BY n.created_at, n.id))[1]::text AS first_id,
            (array_agg(n.id ORDER BY n.created_at DESC, n.id DESC))[1]::text AS last_id,
            max(n.created_at) AS last_at, max(a.name) AS actor_name, max(n.actor_type) AS actor_type, count(*)::int AS saves
       FROM numbered n LEFT JOIN actors a ON a.id::text = n.actor_id
      GROUP BY n.edit_no ORDER BY n.edit_no`,
    [workspaceId, nodeId],
  );
  // Each edit starts from where the one before it ended; the oldest from nothing.
  const edits = sessions.rows.map((s, i) => ({ ...s, before_event: i > 0 ? sessions.rows[i - 1]!.last_id : null })).slice(-INK_EDIT_LIMIT).reverse();
  const drawings = await drawingsOf(workspaceId, edits.flatMap((e) => (e.before_event ? [e.before_event, e.last_id] : [e.last_id])));
  const out: InkEdit[] = [];
  for (const e of edits) {
    const after = drawings.get(e.last_id);
    const before = e.before_event ? drawings.get(e.before_event) : null;
    if (after === undefined || before === undefined) continue;
    const summary = inkChangeSummary(before, after);
    if (summary.added + summary.erased === 0) continue;
    out.push({
      ...summary, id: e.last_id, before_event: e.before_event, after_event: e.last_id, changed_at: e.last_at.toISOString(),
      actor_name: e.actor_name, actor_kind: actorKindOf(e.actor_type), saves: e.saves,
    });
  }
  return out;
}

/** Which of `eventIds` are saves of this note's drawing of `kind`. */
async function inkSavesOf(workspaceId: string, nodeId: string, kind: InkKind, eventIds: string[]): Promise<Set<string>> {
  const rows = await q<{ id: string }>(
    `SELECT e.id::text AS id FROM domain_events e
      WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.id = ANY($3::bigint[]) AND ${inkEventSql("e", kind)}`,
    [workspaceId, nodeId, eventIds],
  );
  return new Set(rows.rows.map((r) => r.id));
}

/** The two drawings behind one change (`beforeEvent` none = nothing drawn yet), for the picture. The events
 *  must be saves of this note's drawing. null when `actor` cannot read the note or an id is not such a save
 *  or its drawing is no longer stored. */
export async function inkChangeValues(
  workspaceId: string, actor: ActorCtx, nodeId: string, kind: InkKind, beforeEvent: string | null, afterEvent: string,
): Promise<{ before: string | null; after: string } | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  if (!EVENT_ID.test(afterEvent) || (beforeEvent !== null && !EVENT_ID.test(beforeEvent))) return null;
  const mine = await inkSavesOf(workspaceId, nodeId, kind, beforeEvent ? [beforeEvent, afterEvent] : [afterEvent]);
  if (!mine.has(afterEvent) || (beforeEvent !== null && !mine.has(beforeEvent))) return null;
  const drawings = await drawingsOf(workspaceId, [...mine]);
  const after = drawings.get(afterEvent);
  const before = beforeEvent ? drawings.get(beforeEvent) : null;
  return after === undefined || before === undefined ? null : { before, after };
}

/** Put one drawing back as it was after the save `eventId`: a new write of the attribute that kind lives in
 *  (`ink_data` for "handwriting", `board_ink` for "board"; never the other one), under the actor's current write
 *  authority, recorded as an ordinary ATTRIBUTE_SET so it shows in History and can be undone like any edit. The
 *  stored drawing is replaced whole (no merge: restoring is a decision to take later strokes out). A save of the
 *  board from before migration 172 (stored under `ink_data`) is restored into `board_ink`.
 *  null when `actor` cannot read the note, `eventId` is not a save of this kind of this note, or its drawing is
 *  no longer stored (or the save removed the drawing: there is nothing to put back). */
export async function restoreInkVersion(
  workspaceId: string, actor: ActorCtx, nodeId: string, kind: InkKind, eventId: string,
): Promise<AttributeWriteResult | null> {
  if (!(await canReadNode(actor, nodeId)) || !EVENT_ID.test(eventId)) return null;
  if (!(await inkSavesOf(workspaceId, nodeId, kind, [eventId])).has(eventId)) return null;
  const value = (await drawingsOf(workspaceId, [eventId])).get(eventId);
  if (!value) return null;
  return setNodeAttribute({ workspaceId, actor, nodeId, attribute: { key: INK_KIND_ATTR[kind], value, value_type: "text" } });
}

// Day lens (depth audit D13: moved verbatim from routes/day.ts) — the read-only, server-computed projection a day node ALSO shows
// besides what the user wrote by hand (Capacities' auto daily timeline /
// acreom's My Day, mechanism-level: a LENS over existing state, never copied
// content). Works for ANY date, so opening an old day note replays that day.
//
// Buckets (each capped, each with a true total):
//   created  nodes whose content_nodes.created_at falls on the date — the
//            column is the substrate's authoritative birth time (NODE_CREATED
//            events only exist for the event-sourced era).
//   edited   nodes with a save (History's definition, services/history saveOnDaySql) on the date,
//            excluding anything already in `created` and the day node itself —
//            attribute/tag churn is deliberately NOT "edited" (it would turn
//            every dispatcher cascade into lens noise).
//   due      tasks due on the date, same row shape + status set as the agenda
//            (modules/tasks/agenda.ts) so the frontend reuses its rendering.
//   agent    nodes touched on the date by actor_type='ai_agent' events — the
//            human–agent-collab bucket. Overlaps created/edited on purpose:
//            it answers "what did the agent touch", not "what else happened".
//
// READ POLICY: every bucket is bounded by the caller's COMBINED read set
// (readableNodeIdSet — role/tag-policy visibility ∩ bearer-token tag scope),
// the same helper /api/events, /api/inbox and the agenda use. System machinery
// (source_type='system', the workspace-config tag node) and hidden nodes stay
// out, mirroring the frontend's isSystemNode + !hidden list conventions.
//
// `items` is the same day as the timeline's DayItems (@onden/markdown dayItems.ts):
// the edit events merged into runs ("改了 3 篇"), the notes created and what the
// agent touched, each at its own time. Tasks are not here — the client already
// holds them and hands them over per module (FrontendModule.dayItems). The items
// come from the same read-bounded queries as the buckets, never a third query
// about "what happened that day".
//
// Read-only — no mutations, no spine involvement.

import { pool } from "../db.js";
import { sqlDayStart } from "../localDay.js";
import { saveOnDaySql } from "./history/index.js";
import { readableScopeSql } from "./readPolicy.js";
import { TASK_COLUMNS_SQL, TASK_JOIN_SQL, taskBucketCaseSql, TASK_HOST_JOIN_SQL, TASK_HOST_LIVE_WHERE } from "./tasksStore.js";
import type { ActorCtx } from "../types.js";
import { mergeEditRuns, sortDayItems, type DayEdit, type DayItem, type DayLens } from "@onden/markdown";
import { NOT_A_NOTE_CHANGE_SQL } from "./nodeRowProjection.js";

import { liveNodeSql, notTagNodeSql } from "../spine/nodeSql.js";
const BUCKET_CAP = 50;
const EDIT_EVENT_CAP = 1000;

// Same open/visible status set the agenda queries — done/cancelled tasks are
// not "due", they're history.
const DUE_STATUSES = ["todo", "doing", "waiting"];

// Backend twin of frontend lib/systemNodes.isSystemNode: system machinery rows
// must stay out of user-facing lists. Plus the lens's own list hygiene: no
// trashed, no hidden, no tags (a tag is not a note made that day), no canvas surfaces (readableNodeIdSet excludes canvas
// nodes anyway; the predicate keeps the SQL self-describing).
const LENS_NODE_FILTER = `
      ${liveNodeSql("n")}
  AND n.hidden = false
  AND n.node_type <> 'canvas'
  AND n.source_type <> 'system'
  AND ${notTagNodeSql("n")}`;

// The day node itself (title or slug IS the date — the SQL spelling of
// @onden/markdown dayNoteDate, the rule the Today button matches on) never lists in its own lens.
// ($2 is also used as ::date in the window predicate, so pg would otherwise
// infer it as `date` — the ::text casts keep the comparison text <> text.)
const NOT_THE_DAY_NODE = `n.title <> $2::text AND n.slug <> $2::text`;

// The date window: [date, date+1) against timestamptz columns, evaluated in
// the workspace clock (zone and day start hour) — the same clock the agenda
// buckets on (localDay.ts).
const ON_DATE = (col: string) => `${col} >= ${sqlDayStart("$2::date")} AND ${col} < ${sqlDayStart("$2::date + 1")}`;

type LensNodeRow = { id: string; title: string; at: string };
type EditEventRow = { id: string; title: string; at: string; actor_id: string };

function bucketOf<T>(rows: T[]): { items: T[]; total: number } {
  return { items: rows.slice(0, BUCKET_CAP), total: rows.length };
}

/** The lens for `date` (YYYY-MM-DD, already validated as a real date). */
export async function dayLens(actor: ActorCtx | null, workspaceId: string, date: string): Promise<DayLens> {
  // Each lens query bounds its rows by the caller's COMBINED read set as a
  // PUSHED-DOWN predicate (on the node n / task node t the row is keyed on),
  // instead of materializing the whole readable set and .filter()-ing after.
  const createdParams: unknown[] = [workspaceId, date];
  const created = await pool.query<LensNodeRow>(
    `SELECT n.id, n.title, n.created_at AS at
       FROM content_nodes n
      WHERE n.workspace_id = $1
        AND ${ON_DATE("n.created_at")}
        AND ${LENS_NODE_FILTER}
        AND ${NOT_THE_DAY_NODE}
        AND ${readableScopeSql(actor, "n", createdParams)}
      ORDER BY n.created_at DESC`,
    createdParams,
  );

  // Edited = saves on the date, deduped against `created` by the
  // same created_at window (a node born and rewritten on the day is "created").
  const editedParams: unknown[] = [workspaceId, date];
  const edited = await pool.query<LensNodeRow>(
    `SELECT n.id, n.title, MAX(e.created_at) AS at
       FROM domain_events e
       JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
      WHERE e.workspace_id = $1
        AND e.target_type = 'node'
        AND ${saveOnDaySql("e", "$2::date")}
        AND NOT (${ON_DATE("n.created_at")})
        AND ${LENS_NODE_FILTER}
        AND ${NOT_THE_DAY_NODE}
        AND ${readableScopeSql(actor, "n", editedParams)}
      GROUP BY n.id, n.title
      ORDER BY MAX(e.created_at) DESC`,
    editedParams,
  );

  // The edit events themselves (not their per-note MAX), for merging into runs:
  // the same saves as `edited` (a move or a rename is not one).
  const editEventParams: unknown[] = [workspaceId, date];
  const editEvents = await pool.query<EditEventRow>(
    `SELECT n.id, n.title, e.created_at AS at, COALESCE(e.actor_id::text, e.actor_type) AS actor_id
       FROM domain_events e
       JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
      WHERE e.workspace_id = $1
        AND e.target_type = 'node'
        AND ${saveOnDaySql("e", "$2::date")}
        AND NOT (${ON_DATE("n.created_at")})
        AND ${LENS_NODE_FILTER}
        AND ${NOT_THE_DAY_NODE}
        AND ${readableScopeSql(actor, "n", editEventParams)}
      ORDER BY e.created_at ASC
      LIMIT ${EDIT_EVENT_CAP}`,
    editEventParams,
  );

  const agentParams: unknown[] = [workspaceId, date];
  const agent = await pool.query<LensNodeRow>(
    `SELECT n.id, n.title, MAX(e.created_at) AS at
       FROM domain_events e
       JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
      WHERE e.workspace_id = $1
        AND e.target_type = 'node'
        AND e.actor_type = 'ai_agent'
        AND ${NOT_A_NOTE_CHANGE_SQL("e")}
        AND ${ON_DATE("e.created_at")}
        AND ${LENS_NODE_FILTER}
        AND ${NOT_THE_DAY_NODE}
        AND ${readableScopeSql(actor, "n", agentParams)}
      GROUP BY n.id, n.title
      ORDER BY MAX(e.created_at) DESC`,
    agentParams,
  );

  // Same row shape AND bucket classifier as GET /api/tasks/agenda (shared
  // TASK_COLUMNS_SQL / taskBucketCaseSql, relative to TODAY — an old day's
  // open task correctly reads "overdue"). Tasks are NODES (migration 062): t =
  // the hidden task node, its host (when it has one) is t.parent_id; a
  // standalone task is judged by its own space. The day is the task's
  // `when_date` (the day to do it).
  const dueParams: unknown[] = [workspaceId, date, DUE_STATUSES];
  const due = await pool.query<{
    id: string; node_id: string | null; node_title: string; title: string;
    status: string; due_date: string | null; recur: string | null; bucket: string; created_at: string;
  }>(
    `SELECT ${TASK_COLUMNS_SQL}, COALESCE(host.title, '') AS node_title,
            ${taskBucketCaseSql()} AS bucket
       ${TASK_JOIN_SQL}
       ${TASK_HOST_JOIN_SQL}
      WHERE t.workspace_id = $1 AND ${liveNodeSql("t")}
        AND ${TASK_HOST_LIVE_WHERE}
        AND w.value = $2::text
        AND s.value = ANY($3::text[])
        AND ${readableScopeSql(actor, "t", dueParams)}
      ORDER BY t.created_at ASC`,
    dueParams,
  );

  const dueRows = due.rows;

  const nowMs = Date.now();
  const edits: DayEdit[] = editEvents.rows.map((r) => ({ nodeId: r.id, title: r.title, at: new Date(r.at).toISOString(), actorId: r.actor_id }));
  const asItem = (kind: DayItem["kind"], r: LensNodeRow): DayItem => ({
    at: new Date(r.at).toISOString(), kind, title: r.title, ref: { type: "note", id: r.id }, past: new Date(r.at).getTime() < nowMs,
  });
  const items = sortDayItems([
    ...mergeEditRuns(edits, nowMs),
    ...created.rows.map((r) => asItem("created", r)),
    ...agent.rows.map((r) => asItem("agent", r)),
  ]);

  return {
    date,
    items,
    buckets: {
      created: bucketOf(created.rows),
      edited:  bucketOf(edited.rows),
      // Read policy on the task NODE itself — host restriction cascades via
      // parent_id, and a per-task restrictive tag works too (062's payoff).
      due:     bucketOf(dueRows),
      agent:   bucketOf(agent.rows),
    },
  };
}

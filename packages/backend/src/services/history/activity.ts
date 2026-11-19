// Workspace activity for History: edits per day, the notes edited on a day,
// the agent runs of that day and the recently deleted notes. Reads only the
// notes `actor` can read (readableNotes.ts, readPolicy).
//
// An "edit" is the version list's unit (routes/nodes.ts GET /:id/versions): a
// run of saves (typing or drawing, bodyEvents.ts startsNewEditSql) to one note
// by one actor, none more than 5 minutes after the one before, counts once;
// creating and restoring are edits of their own. An
// edit belongs to the day (workspace time zone and day start) of its last save.

import { q } from "../../db.js";
import { shownAuthorKind, shownAuthorName } from "../authorName.js";
import { addDays, localDayId, sqlDayStart, sqlLocalDate, sqlLocalDay } from "../../localDay.js";
import type { ActorCtx } from "../../types.js";
import { summarizeChange, ellipsize, UUID_SOURCE } from "@onden/markdown";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { sqlInt } from "../../sqlText.js";
import { canReadRetainedNode, readableTrashedNodeIds } from "../readPolicy.js";
import { agentRunsStartedBetween } from "./agentRuns.js";
import { bodiesByHash, bodyEventSql, editEventSql, lastBodyHashBeforeSql, startsNewEditSql } from "./bodyEvents.js";
import { dayInkChanges } from "./inkChanges.js";
import { promptFor, promptReaderOf } from "../sessionPromptReader.js";
import { readableNotesSql } from "./readableNotes.js";
import { isRunUndone } from "./agentRunUndo.js";
import { describeChange } from "./noteVersions.js";
import { rewindsBetween } from "./rewind.js";
import { systemTidiesByDay } from "./systemTidies.js";
import type { ActivityDay, DayAgentRun, DayInkChange, DayNote, DayNoteChange, DayNotes, DayRewind, DayTidy, DeletedNote, DeletedNoteBody, Feed, FeedDay } from "@onden/contract";

export const SUMMARY_MAX = 80;
/** How many notes of a day the feed sends; the rest come page by page (notesEditedPage). */
export const FEED_NOTES_PER_DAY = 50;
/** The names a new note starts with (frontend `t("Untitled")`, quick capture's 新筆記, both locales). */
export const PLACEHOLDER_TITLES = ["Untitled", "未命名", "New Note", "New note", "新筆記"];

/** Narrow History to one space (`space` query param). On top of the read
 *  rule, so a space `actor` cannot read yields nothing, same as an empty one. */
export type SpaceFilter = { spaceId?: string };

/** The saves of readable notes from `since` (a local date) on, collapsed into
 *  edits. The window starts a day early so the first edit's boundary is right. */
function editsSql(readable: string, sinceParam: string): string {
  return `WITH saves AS (
       SELECT e.id, e.target_id, e.actor_id, e.actor_type, e.event_type, e.created_at
         FROM domain_events e
         JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
        WHERE e.workspace_id = $1
          AND ${editEventSql("e")}
          AND e.created_at >= ${sqlDayStart(`${sinceParam}::date - 1`)}
          AND ${readable}
     ),
     marked AS (
       SELECT *, CASE WHEN ${startsNewEditSql("w")} THEN 1 ELSE 0 END AS boundary
         FROM saves WINDOW w AS (PARTITION BY target_id ORDER BY created_at, id)
     ),
     edits AS (
       SELECT target_id, actor_id, actor_type,
              min(created_at) AS first_at, max(created_at) AS last_at,
              bool_or(event_type = 'NODE_CREATED') AS created
         FROM (SELECT *, sum(boundary) OVER (PARTITION BY target_id ORDER BY created_at, id) AS edit_no FROM marked) s
        GROUP BY target_id, edit_no, actor_id, actor_type
     )`;
}

/** Who edited a note on a day: the authors this node holds an `actors` row for (a removed member or AI is not listed, as before sessions existed), a
 *  person or an AI by name, a temporary session by the kind 'session' alone (services/authorName.ts; every session of the day shows once). */
function shownActors(rows: Array<{ name: string; type: string }>): DayNote["actors"] {
  const out = new Map<string, DayNote["actors"][number]>();
  for (const { name, type } of rows) {
    const kind = shownAuthorKind(type, type === "agent" ? "agent" as const : "human" as const);
    const shown = shownAuthorName(type, name);
    out.set(`${kind}:${shown ?? ""}`, kind === "session" ? { name: null, kind } : { name: shown ?? "", kind });
  }
  return [...out.values()];
}

/** Edits per local day for the `days` days ending `until` (default today), `until` last. */
export async function activityByDay(actor: ActorCtx, workspaceId: string, days: number, until: string = localDayId(), { spaceId }: SpaceFilter = {}): Promise<ActivityDay[]> {
  const first = addDays(until, -(days - 1));
  const params: unknown[] = [workspaceId];
  const readable = await readableNotesSql(actor, workspaceId, "n", params, { spaceId });
  const since = `$${params.push(first)}`;
  const last = `$${params.push(until)}`;
  const rows = await q<{ day: string; actor_type: string; edits: number }>(
    `${editsSql(readable, since)}
     SELECT ${sqlLocalDay("last_at")} AS day, actor_type, count(*)::int AS edits
       FROM edits
      WHERE ${sqlLocalDate("last_at")} >= ${since}::date
        AND ${sqlLocalDate("last_at")} <= ${last}::date
      GROUP BY 1, 2`,
    params,
  );
  const out = new Map<string, ActivityDay>();
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    out.set(date, { date, you: 0, agents: 0 });
  }
  for (const r of rows.rows) {
    const day = out.get(r.day);
    if (!day) continue;
    if (r.actor_type === "ai_agent") day.agents += r.edits; else day.you += r.edits;
  }
  return [...out.values()];
}

/** The notes edited on `date` (YYYY-MM-DD, workspace time zone). */
export async function notesEditedOn(actor: ActorCtx, workspaceId: string, date: string, space: SpaceFilter = {}): Promise<DayNote[]> {
  return (await notesEditedBetween(actor, workspaceId, date, date, space)).get(date)?.notes ?? [];
}

/** A page of the notes edited on `date`, newest first, with how many there are
 *  in all and the day's edit count (what 「顯示更多」 reads). */
export async function notesEditedPage(actor: ActorCtx, workspaceId: string, date: string, page: { offset: number; limit: number }, space: SpaceFilter = {}): Promise<DayNotes> {
  return (await notesEditedBetween(actor, workspaceId, date, date, space, page)).get(date) ?? { notes: [], notes_total: 0, edits_total: 0 };
}

/** One day's notes: a page of them (`notes`), how many notes `notes_total` and
 *  how many edits `edits_total` the whole day has. */

/** The notes edited on each local day of [from, to], by day (a day without
 *  edits is absent), each newest first. One pass for the whole range.
 *  `page`: only that slice of each day's notes (and only their changes are
 *  worked out); the totals still count the whole day. */
async function notesEditedBetween(actor: ActorCtx, workspaceId: string, from: string, to: string, { spaceId }: SpaceFilter = {}, page?: { offset: number; limit: number }): Promise<Map<string, DayNotes>> {
  const params: unknown[] = [workspaceId];
  const readable = await readableNotesSql(actor, workspaceId, "n", params, { spaceId });
  const first = `$${params.push(from)}`;
  const last = `$${params.push(to)}`;
  const slice = page ? `WHERE r.rn > ${`$${params.push(page.offset)}`}::int AND r.rn <= ${`$${params.push(page.offset + page.limit)}`}::int` : "";
  // by_note: one row per (day, note), ranked newest first; the actors of a
  // (day, note) are aggregated once in by_actor and joined to the rows kept,
  // not looked up per row.
  const rows = await q<{
    day: string; id: string; title: string; space_id: string | null; edits: number; first_at: Date; last_at: Date; created: boolean;
    actors: Array<{ name: string; type: string }>; notes_total: number; edits_total: number;
  }>(
    `${editsSql(readable, first)},
     in_range AS (
       SELECT ed.*, ${sqlLocalDay("ed.last_at")} AS day FROM edits ed
        WHERE ${sqlLocalDate("ed.last_at")} BETWEEN ${first}::date AND ${last}::date
     ),
     by_note AS (
       SELECT day, n.id, n.title, n.space_id, count(*)::int AS edits,
              min(ed.first_at) AS first_at, max(ed.last_at) AS last_at, bool_or(ed.created) AS created
         FROM in_range ed JOIN content_nodes n ON n.id::text = ed.target_id
        GROUP BY day, n.id, n.title, n.space_id
     ),
     ranked AS (
       SELECT *, row_number() OVER (PARTITION BY day ORDER BY last_at DESC, id) AS rn,
              count(*) OVER (PARTITION BY day)::int AS notes_total, sum(edits) OVER (PARTITION BY day)::int AS edits_total
         FROM by_note
     ),
     by_actor AS (
       SELECT s.day, s.target_id,
              jsonb_agg(DISTINCT jsonb_build_object('name', a.name, 'type', a.type)) AS actors
         FROM (SELECT DISTINCT day, target_id, actor_id FROM in_range) s
         JOIN actors a ON a.id::text = s.actor_id
        GROUP BY s.day, s.target_id
     )
     SELECT r.day, r.id::text AS id, r.title, r.space_id::text AS space_id, r.edits, r.first_at, r.last_at, r.created,
            COALESCE(ba.actors, '[]'::jsonb) AS actors, r.notes_total, r.edits_total
       FROM ranked r
       LEFT JOIN by_actor ba ON ba.day = r.day AND ba.target_id = r.id::text
       ${slice}
      ORDER BY r.day DESC, r.rn`,
    params,
  );
  const pairs = rows.rows.map((r) => ({ nodeId: r.id, day: r.day }));
  const [changes, inks, boards] = await Promise.all([dayChanges(workspaceId, pairs), dayInkChanges(workspaceId, pairs, "handwriting"), dayInkChanges(workspaceId, pairs, "board")]);
  const out = new Map<string, DayNotes>();
  for (const r of rows.rows) {
    const note: DayNote = {
      id: r.id, title: r.title, space_id: r.space_id, edits: r.edits, first_at: r.first_at.toISOString(), last_at: r.last_at.toISOString(),
      actors: shownActors(r.actors), created: r.created, change: changes.get(`${r.day}:${r.id}`) ?? null, ink: inks.get(`${r.day}:${r.id}`) ?? null, board_ink: boards.get(`${r.day}:${r.id}`) ?? null,
    };
    (out.get(r.day) ?? out.set(r.day, { notes: [], notes_total: r.notes_total, edits_total: r.edits_total }).get(r.day)!).notes.push(note);
  }
  return out;
}

/** For each (note, day): describeChange from the body the note had before the
 *  day's first save (the last body event before the day began; none = a new
 *  note, "") to the body after its last save that day. Keyed `day:nodeId`;
 *  absent when a body's blob is gone. One statement for all pairs: the two
 *  lookups per pair run as LATERAL joins on the pairs kept, not per candidate row. */
async function dayChanges(workspaceId: string, pairs: Array<{ nodeId: string; day: string }>): Promise<Map<string, DayNoteChange>> {
  if (pairs.length === 0) return new Map();
  const hashes = await q<{ node_id: string; day: string; pre: string | null; post: string | null }>(
    `SELECT x.node_id, x.day, pre.hash AS pre, post.hash AS post
       FROM unnest($2::text[], $3::text[]) AS x(node_id, day)
       LEFT JOIN LATERAL (SELECT ${lastBodyHashBeforeSql("$1", "x.node_id", { time: sqlDayStart("x.day::date") })} AS hash) pre ON true
       LEFT JOIN LATERAL (SELECT ${lastBodyHashBeforeSql("$1", "x.node_id", { time: sqlDayStart("x.day::date + 1") })} AS hash) post ON true`,
    [workspaceId, pairs.map((p) => p.nodeId), pairs.map((p) => p.day)],
  );
  const bodies = await bodiesByHash(hashes.rows.flatMap((r) => [...(r.pre ? [r.pre] : []), ...(r.post ? [r.post] : [])]));
  const out = new Map<string, DayNoteChange>();
  for (const r of hashes.rows) {
    const after = r.post ? bodies.get(r.post) : undefined;
    const before = r.pre ? bodies.get(r.pre) : "";
    if (after === undefined || before === undefined) continue;
    out.set(`${r.day}:${r.node_id}`, describeChange(before, after));
  }
  return out;
}

/** Agent runs that started on `date`, newest first. */
export async function agentRunsOn(actor: ActorCtx, workspaceId: string, date: string, space: SpaceFilter = {}): Promise<DayAgentRun[]> {
  return (await agentRunsBetween(actor, workspaceId, date, date, space)).get(date) ?? [];
}

/** Agent runs that started on each local day of [from, to], by day, newest first. */
async function agentRunsBetween(actor: ActorCtx, workspaceId: string, from: string, to: string, space: SpaceFilter = {}): Promise<Map<string, DayAgentRun[]>> {
  const bounds = await q<{ from: Date; to: Date }>(
    `SELECT ${sqlDayStart("$1::date")} AS "from", ${sqlDayStart("$2::date + 1")} AS "to"`,
    [from, to],
  );
  const runs = await agentRunsStartedBetween(actor, workspaceId, bounds.rows[0]!.from, bounds.rows[0]!.to, space.spaceId);
  const out = new Map<string, DayAgentRun[]>();
  if (runs.length === 0) return out;

  const bodies = await bodiesByHash(runs.flatMap((r) => r.notes.flatMap((n) => [n.endHash, ...(n.preHash ? [n.preHash] : [])])));
  const sessionIds = runs.flatMap((r) => (r.sessionId ? [r.sessionId] : []));
  const reader = await promptReaderOf(actor);
  const prompts = sessionIds.length === 0 ? [] : (await q<{ id: string; initiator_id: string; prompt: string }>(
    `SELECT id::text, initiator_id::text, prompt FROM agent_sessions WHERE workspace_id = $1 AND id::text = ANY($2::text[])`,
    [workspaceId, sessionIds],
  )).rows;
  const promptOf = new Map(prompts.map((p) => [p.id, promptFor(reader, p.initiator_id, p.prompt)]));

  for (const run of runs) {
    const item: DayAgentRun = {
      run_id: run.runId,
      agent_name: run.agentName,
      started_at: run.startedAt.toISOString(),
      summary: summarize(run.sessionId ? promptOf.get(run.sessionId) : undefined),
      notes: run.notes.map((n) => {
        const before = n.preHash ? bodies.get(n.preHash) ?? "" : "";
        const after = bodies.get(n.endHash) ?? "";
        const { added, changed, removed } = summarizeChange(before, after);
        return { id: n.nodeId, title: n.title, space_id: n.spaceId, added, changed, removed, created: n.created };
      }),
      undone: await isRunUndone(workspaceId, run),
    };
    const day = localDayId(run.startedAt);
    (out.get(day) ?? out.set(day, []).get(day)!).push(item);
  }
  for (const list of out.values()) list.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return out;
}

/** Rewinds ("還原到這時") done on each local day of [from, to], by day, newest first. */
async function rewindsByDay(actor: ActorCtx, workspaceId: string, from: string, to: string, space: SpaceFilter = {}): Promise<Map<string, DayRewind[]>> {
  const bounds = await q<{ from: Date; to: Date }>(
    `SELECT ${sqlDayStart("$1::date")} AS "from", ${sqlDayStart("$2::date + 1")} AS "to"`,
    [from, to],
  );
  const out = new Map<string, DayRewind[]>();
  for (const card of await rewindsBetween(actor, workspaceId, bounds.rows[0]!.from, bounds.rows[0]!.to, space)) {
    const day = localDayId(new Date(card.at));
    (out.get(day) ?? out.set(day, []).get(day)!).push(card);
  }
  return out;
}

/** Rewinds done on `date`, newest first. */
export async function rewindsOn(actor: ActorCtx, workspaceId: string, date: string, space: SpaceFilter = {}): Promise<DayRewind[]> {
  return (await rewindsByDay(actor, workspaceId, date, date, space)).get(date) ?? [];
}

/** The days of [until-days+1, until] that have a note edit or an agent run,
 *  newest first, each with its notes and runs (History's default list). */
export async function feedByDay(actor: ActorCtx, workspaceId: string, until: string, days: number, space: SpaceFilter = {}, notesPerDay: number = FEED_NOTES_PER_DAY): Promise<Feed> {
  const from = addDays(until, -(days - 1));
  const [notes, runs, rewinds, tidies, earlier] = await Promise.all([
    notesEditedBetween(actor, workspaceId, from, until, space, { offset: 0, limit: notesPerDay }),
    agentRunsBetween(actor, workspaceId, from, until, space),
    rewindsByDay(actor, workspaceId, from, until, space),
    systemTidiesByDay(actor, workspaceId, from, until, space.spaceId),
    latestSaveDayBefore(actor, workspaceId, from, space),
  ]);
  const dates = [...new Set([...notes.keys(), ...runs.keys(), ...rewinds.keys(), ...tidies.keys()])].sort().reverse();
  const ends = await dayEnds(dates);
  return {
    days: dates.map((date) => ({ date, end_at: ends.get(date)!, notes: notes.get(date)?.notes ?? [], notes_total: notes.get(date)?.notes_total ?? 0, edits_total: notes.get(date)?.edits_total ?? 0, agent_runs: runs.get(date) ?? [], rewinds: rewinds.get(date) ?? [], system_tidies: tidies.get(date) ?? [] })),
    earlier_day: earlier,
  };
}

/** The last instant (1 ms before the next day starts, on the workspace clock) of each local day. */
async function dayEnds(dates: string[]): Promise<Map<string, string>> {
  if (dates.length === 0) return new Map();
  const r = await q<{ day: string; end_at: Date }>(
    `SELECT d::text AS day, (${sqlDayStart("d + 1")}) - interval '1 millisecond' AS end_at
       FROM unnest($1::date[]) AS d`,
    [dates],
  );
  return new Map(r.rows.map((row) => [row.day, row.end_at.toISOString()]));
}

async function latestSaveDayBefore(actor: ActorCtx, workspaceId: string, day: string, { spaceId }: SpaceFilter = {}): Promise<string | null> {
  const params: unknown[] = [workspaceId];
  const readable = await readableNotesSql(actor, workspaceId, "n", params, { spaceId });
  const before = `$${params.push(day)}`;
  const r = await q<{ day: string | null }>(
    `SELECT ${sqlLocalDay("e.created_at")} AS day
       FROM domain_events e
       JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
      WHERE e.workspace_id = $1
        AND ${editEventSql("e")}
        AND e.created_at < ${sqlDayStart(`${before}::date`)}
        AND ${readable}
      ORDER BY e.created_at DESC LIMIT 1`,
    params,
  );
  return r.rows[0]?.day ?? null;
}

function summarize(prompt: string | undefined): string {
  const one = (prompt ?? "").replace(/\s+/g, " ").trim();
  return ellipsize(one, SUMMARY_MAX);
}

/** Where the next, older page of 「最近刪除」 starts: the deletion time (ms) and id of the last row shown. Opaque to the client. */
type DeletedCursor = string;
const CURSOR = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\|(${UUID_SOURCE})$`);
/** Sorts after every id: a cursor "at" a time with it skips every note deleted at that time. */
const LAST_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
export const isDeletedCursor = (value: string): boolean => CURSOR.test(value);
export const DELETED_PAGE_DEFAULT = 50;

type DeletedPage = { notes: DeletedNote[]; older_cursor: DeletedCursor | null };
/** The first page is the last `days` days (all of them); an older page is `limit` notes after `before`. */
export type DeletedWindow = { days: number } | { before: DeletedCursor; limit?: number };

/** Notes deleted that `actor` can read, newest first, as the root of each
 *  deletion only (its descendants come back with it). A cascade stamps
 *  every row with the same deleted_at (one transaction), which is how a
 *  descendant is told from a note deleted on its own. Nothing is purged by age:
 *  the first page is the last `days` days and `older_cursor`, when not null,
 *  continues the list with `before` until it is null. Order and cursor use the
 *  deletion time to the millisecond (what the client gets), then the id. */
export async function recentlyDeleted(actor: ActorCtx, workspaceId: string, window: DeletedWindow, { spaceId }: SpaceFilter = {}): Promise<DeletedPage> {
  const readable = [...await readableTrashedNodeIds(actor, workspaceId)];
  if (readable.length === 0) return { notes: [], older_cursor: null };
  const params: unknown[] = [workspaceId, readable, PLACEHOLDER_TITLES];
  const inSpace = spaceId ? `AND n.space_id = $${params.push(spaceId)}` : "";
  const at = "date_trunc('milliseconds', n.deleted_at)";
  let range: string;
  let limit = "";
  if ("before" in window) {
    const [, time, id] = CURSOR.exec(window.before)!;
    const t = `$${params.push(time)}::timestamptz`;
    range = `AND (${at} < ${t} OR (${at} = ${t} AND n.id > $${params.push(id)}::uuid))`;
    limit = `LIMIT ${sqlInt((window.limit ?? DELETED_PAGE_DEFAULT) + 1)}`;
  } else {
    range = `AND n.deleted_at >= now() - ($${params.push(window.days)}::int * interval '1 day')`;
  }
  // blank: a plain note with no text, no note under it (deleted or not, so a
  // purge takes exactly its own id), nothing kept beside the text (ink_data,
  // sketch_data; `_`-keys are import/publish bookkeeping) and only a
  // placeholder title — none, a default name, or a bare date (an empty daily
  // note). Notes get a default name on create, never an empty title.
  const rows = await q<{ id: string; title: string; deleted_at: Date; space_id: string | null; blank: boolean }>(
    `SELECT n.id::text AS id, n.title, ${at} AS deleted_at, n.space_id::text AS space_id,
            (n.node_type = 'content' AND n.markdown !~ '\\S'
             AND (n.title !~ '\\S' OR btrim(n.title) = ANY($3::text[]) OR btrim(n.title) ~ '^\\d{4}-\\d{2}-\\d{2}$')
             AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = n.id)
             AND NOT EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = n.id AND a.key NOT LIKE '\\_%')) AS blank
       FROM content_nodes n
       LEFT JOIN content_nodes p ON p.id = n.parent_id AND p.deleted_at = n.deleted_at
      WHERE n.workspace_id = $1 AND n.id::text = ANY($2::text[]) AND n.deleted_at IS NOT NULL
        ${range}
        AND n.hidden = false AND p.id IS NULL ${inSpace}
      ORDER BY ${at} DESC, n.id ${limit}`,
    params,
  );
  const toNote = (r: (typeof rows.rows)[number]): DeletedNote => ({ id: r.id, title: r.title, deleted_at: r.deleted_at.toISOString(), space_id: r.space_id, blank: r.blank });
  const cursorOf = (r: { deleted_at: Date; id: string }): DeletedCursor => `${r.deleted_at.toISOString()}|${r.id}`;
  if ("before" in window) {
    const pageSize = window.limit ?? DELETED_PAGE_DEFAULT;
    const page = rows.rows.slice(0, pageSize);
    return { notes: page.map(toNote), older_cursor: rows.rows.length > pageSize ? cursorOf(page[page.length - 1]!) : null };
  }
  // The window's notes are all shown; is there anything older? Continue after the last one, or at the window's start when none is in it.
  const start = (await sql<{ at: Date }>`SELECT date_trunc('milliseconds', now() - (${window.days}::int * interval '1 day')) AS at`.execute(db)).rows[0]!.at;
  const last = rows.rows[rows.rows.length - 1];
  const from = last ? cursorOf(last) : `${start.toISOString()}|${LAST_ID}`;
  const older = await recentlyDeleted(actor, workspaceId, { before: from, limit: 1 }, { spaceId });
  return { notes: rows.rows.map(toNote), older_cursor: older.notes.length > 0 ? from : null };
}

/** One deleted note's last text, for the preview beside the Recently deleted list.
 *  null when it is not deleted, is gone for good, or `actor` may not read it
 *  (the same rule as the list: a note that is not in the list has no body here either). */
export async function deletedNoteBody(actor: ActorCtx, workspaceId: string, nodeId: string, { spaceId }: SpaceFilter = {}): Promise<DeletedNoteBody | null> {
  if (!await canReadRetainedNode(actor, nodeId)) return null;
  const params: unknown[] = [workspaceId, nodeId];
  const inSpace = spaceId ? `AND space_id = $${params.push(spaceId)}` : "";
  const rows = await q<{ id: string; title: string; markdown: string; deleted_at: Date }>(
    `SELECT id::text AS id, title, markdown, deleted_at FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL AND hidden = false ${inSpace}`,
    params,
  );
  const row = rows.rows[0];
  return row ? { id: row.id, title: row.title, markdown: row.markdown, deleted_at: row.deleted_at.toISOString() } : null;
}

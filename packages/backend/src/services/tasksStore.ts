// Tasks-as-nodes storage (migration 062 — the node-uniformity migration; the
// tasks module and standalone tasks, migration 135).
//
// A task is an ordinary NODE: hidden=true, title = the task title, referencing
// the tasks function (a function_refs row; spine/taskIdentity.ts) and carrying the reserved attributes:
//
//   _task_status    todo|doing|waiting|done|cancelled         (always present)
//   _task_when      YYYY-MM-DD   the day to do it             (absent = no day)
//   _task_evening   true         ...in the evening of that day
//   _task_someday   true         no day: whenever (parked)
//   _task_deadline  YYYY-MM-DD   the last day it may be done
//   _task_recur     <n><d|w|m>   (absent = one-off)
//   _task_recur_mode fixed|after (absent = fixed)
//   _task_remind_at ISO instant or wall-clock YYYY-MM-DDTHH:MM[:SS]
//   _task_time      HH:MM        the clock time it starts       (absent = no time)
//   _task_until     HH:MM        when it ends, later than time  (absent = no end)
//   _task_done_at   ISO instant  when the status last became done (absent unless done)
//
// time and until are written at the start of the task's line
// (`- [ ] 15:00–16:00 title {task}`, @onden/markdown taskTime): the line's text
// is the source and the attributes follow it (modules/tasks/blockTasks.ts), and
// a time changed on the task is written back to the line (lines.ts).
//
// parent_id is the host note when the task is a line of a note (block-nodes.md
// B4) or was added under one, and NULL for a standalone task, which lives in
// its own space (the creator's personal space unless named) and is read and
// written by that space's rule like any node. A task sits in its host's space.
//
// Why nodes: node_tasks was the substrate's last big parallel table — tasks
// didn't merge, didn't restore, didn't pass inbox governance, didn't respect
// read policy ([[collab-merge-model]] "node = main primitive, not yet the only
// one"). As nodes they get all four for free: every mutation is a spine event
// (NODE_CREATED / ATTRIBUTE_SET) with an inverse, and every read flows through
// readableNodeIdSet like any other node.
//
// This is the substrate, in core: sync, trash, backup and read policy read
// task nodes whether or not the tasks module is on. What tasks DO (routes,
// updates, the scheduler, placing into notes) is modules/tasks.
//
// The API shape is additive: routes synthesize the old node_tasks row shape
// ({ id, node_id, title, status, due_date, recur, … }) from nodes+attrs and add
// the newer fields; `due_date` stays as the alias of `when_date` for older
// clients. Migration 062 reused the old node_tasks.id as the task node id, so
// frontend ids stay valid across the migration.

import { putBlob } from "./blobs.js";
import { recordVersion } from "../spine/noteVersions.js";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { sql } from "kysely";
import { functionTagNames, insertFunctionRefs } from "./functionRefs.js";
import { db } from "../dbKysely.js";
import { localDayId } from "../localDay.js";
import type { finishNewNote } from "./newNoteDerived.js";
import { UPCOMING_DAYS, derivedIdName, freeFormType, isCalendarDay, isUuid, type TaskStatus } from "@onden/markdown";
import { derivedId } from "./derivedIds.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { ActorCtx } from "../types.js";
import { K, TASK_FUNCTION_ID, TASK_TAG_NAME, hasTaskRefSql } from "../spine/taskIdentity.js";
import { liveNodeSql } from "../spine/nodeSql.js";
export { TASK_TAG_NAME, K } from "../spine/taskIdentity.js";

export type RecurMode = "fixed" | "after";

/** The synthesized row — the retired node_tasks shape the frontend
 *  (lib/api.ts NodeTask, localDb, bootstrap `tasks` array) already holds,
 *  plus the standalone/when/deadline/reminder fields. */
export type TaskRow = {
  id: string;
  workspace_id: string;
  /** The host note; null for a standalone task. */
  node_id: string | null;
  title: string;
  status: TaskStatus;
  /** The day to do it. */
  when_date: string | null;
  /** Alias of `when_date`, for clients and queued writes older than migration 135. */
  due_date: string | null;
  evening: boolean;
  someday: boolean;
  deadline: string | null;
  recur: string | null;
  recur_mode: RecurMode;
  remind_at: string | null;
  /** HH:MM it starts, written on its line when it has one. */
  time: string | null;
  /** HH:MM it ends. */
  until: string | null;
  /** ISO instant it was completed; null unless its status is done. */
  done_at: string | null;
  /** The `^id` of its line in the host note, when it is a line of it. */
  block_ref: string | null;
  space_id: string | null;
  /** The task has text of its own (read and written as a note body). */
  has_body: boolean;
  created_at: string;
  updated_at: string;
};

// The canonical join: a task node is a non-deleted node referencing the tasks
// function (function_refs; the index is function_refs_holder_node_idx) with a _task_status attribute. Aliases: t = the task node,
// s/w/ev/sd/dl/r/rm/ra = its attrs (status, when, evening, someday, deadline,
// recur, recur mode, remind-at; tm/un/da = time, until, done-at). (Soft-deleted task nodes drop out here —
// same as CASCADE used to.)
export const TASK_JOIN_SQL = `
    FROM content_nodes t
    JOIN function_refs tref ON tref.holder_node_id = t.id
     AND tref.function_id = '${TASK_FUNCTION_ID}' AND tref.instance = ''
    JOIN node_attributes s ON s.node_id = t.id AND s.key = '${K.status}'
    LEFT JOIN node_attributes w ON w.node_id = t.id AND w.key = '${K.when}'
    LEFT JOIN node_attributes ev ON ev.node_id = t.id AND ev.key = '${K.evening}'
    LEFT JOIN node_attributes sd ON sd.node_id = t.id AND sd.key = '${K.someday}'
    LEFT JOIN node_attributes dl ON dl.node_id = t.id AND dl.key = '${K.deadline}'
    LEFT JOIN node_attributes r ON r.node_id = t.id AND r.key = '${K.recur}'
    LEFT JOIN node_attributes rm ON rm.node_id = t.id AND rm.key = '${K.recurMode}'
    LEFT JOIN node_attributes ra ON ra.node_id = t.id AND ra.key = '${K.remindAt}'
    LEFT JOIN node_attributes tm ON tm.node_id = t.id AND tm.key = '${K.time}'
    LEFT JOIN node_attributes un ON un.node_id = t.id AND un.key = '${K.until}'
    LEFT JOIN node_attributes da ON da.node_id = t.id AND da.key = '${K.doneAt}'`;

/** The host of a task row, which must be alive when there is one: a task in a
 *  trashed note is trashed with it, and serving it would leak the trashed
 *  note's id. A standalone task has no host. Alias `host`; put
 *  TASK_HOST_LIVE_WHERE in the WHERE. */
export const TASK_HOST_JOIN_SQL = `
      LEFT JOIN content_nodes host ON host.id = t.parent_id AND ${liveNodeSql("host")}`;
export const TASK_HOST_LIVE_WHERE = `(t.parent_id IS NULL OR host.id IS NOT NULL)`;

/** The columns of a TaskRow, from the TASK_JOIN_SQL aliases. */
export const TASK_COLUMNS_SQL = `
         t.id, t.workspace_id, t.parent_id AS node_id, t.title,
         s.value AS status,
         w.value AS when_date, w.value AS due_date,
         COALESCE(ev.value = 'true', false) AS evening,
         COALESCE(sd.value = 'true', false) AS someday,
         dl.value AS deadline, r.value AS recur,
         COALESCE(rm.value, 'fixed') AS recur_mode, ra.value AS remind_at,
         tm.value AS time, un.value AS until, da.value AS done_at,
         (SELECT b.block_ref FROM block_nodes b WHERE b.task_id = t.id AND b.hidden_at IS NULL AND b.detached_note_id IS NULL) AS block_ref,
         t.space_id, COALESCE(btrim(t.markdown), '') <> '' AS has_body,
         t.created_at, t.updated_at`;

const TASK_ROW_SELECT = `
  SELECT ${TASK_COLUMNS_SQL}
  ${TASK_JOIN_SQL}`;

// The agenda/day bucket classifier — relative to TODAY (workspace clock), so an
// old day's still-open task reads 'overdue'. Dates are compared as TEXT
// (YYYY-MM-DD orders like the date it spells), so a malformed attribute value
// can never throw a cast error. SHARED by GET /api/tasks/agenda and the day
// lens so the two cannot drift. Aliases s/w/sd come from TASK_JOIN_SQL; emit
// `${taskBucketCaseSql()} AS bucket` at the call site. A someday task is
// 'later' whatever its day; the bucket names are the ones the Tasks page has
// always had.
export function taskBucketCaseSql(today: string = localDayId()): string {
  // `today` is built from digits by localDayId; the guard keeps it so.
  if (!isCalendarDay(today)) throw new Error("today must be YYYY-MM-DD");
  return `
            CASE
              WHEN s.value = 'waiting' THEN 'waiting'
              WHEN sd.value = 'true' THEN 'later'
              WHEN w.value IS NULL THEN 'unscheduled'
              WHEN w.value <  '${today}' THEN 'overdue'
              WHEN w.value =  '${today}' THEN 'today'
              WHEN w.value <= to_char('${today}'::date + ${UPCOMING_DAYS}, 'YYYY-MM-DD') THEN 'upcoming'
              ELSE 'scheduled'
            END`;
}

/** SQL fragment excluding task nodes from a node listing (bootstrap's general
 *  nodes array must not grow a hidden task node per todo item). `alias` is the
 *  content_nodes alias of the outer query. */
export function notATaskNodeSql(alias: string): string {
  return `NOT ${hasTaskRefSql(alias)}`;
}

export async function taskRowById(workspaceId: string, id: string): Promise<TaskRow | null> {
  const r = await q<TaskRow>(
    `${TASK_ROW_SELECT}
      WHERE t.workspace_id = $1 AND ${liveNodeSql("t")} AND t.id = $2`,
    [workspaceId, id],
  );
  return r.rows[0] ?? null;
}

/** Sync-delta synthesis. Requires a LIVE host when there is one
 *  (TASK_HOST_JOIN_SQL), like taskRowsForBootstrap and the agenda query:
 *  trashing a note must pull its task children off every list surface (LAW 3
 *  in compositionLaws.integration.test.ts), and the synthesized row carries
 *  `node_id` = the host — without this join, /api/sync leaked the trashed
 *  host's id through its surviving task rows. (The 062 read-policy cascade
 *  via parent_id covers TAG POLICY only; visibleNodeIdsForActor's ancestor
 *  walk simply stops at a deleted parent, it does not hide live children —
 *  so host liveness must be enforced here, at the row source.) A standalone
 *  task has no host and is not held back by one. */
export async function taskRowsByIds(workspaceId: string, ids: string[]): Promise<TaskRow[]> {
  if (ids.length === 0) return [];
  const r = await q<TaskRow>(
    `${TASK_ROW_SELECT}
      ${TASK_HOST_JOIN_SQL}
      WHERE t.workspace_id = $1 AND ${liveNodeSql("t")} AND t.id IN (SELECT unnest($2::uuid[]))
        AND ${TASK_HOST_LIVE_WHERE}
      ORDER BY t.created_at ASC`,
    [workspaceId, ids],
  );
  return r.rows;
}

/** Whether a reader whose readable node ids are `readable` may be sent this
 *  synthesized row: the task node itself AND its host when it has one (the
 *  row carries the host's id as `node_id`, so a host outside the read set must
 *  not leak through it). A standalone task is judged by its own id alone. */
export function taskRowReadable(readable: ReadonlySet<string>, row: Pick<TaskRow, "id" | "node_id">): boolean {
  return readable.has(row.id) && (row.node_id === null || readable.has(row.node_id));
}

/** Bootstrap synthesis: the `tasks` array, bounded by the caller's visible-node
 *  set on BOTH ends — the task node itself (read policy now applies to tasks;
 *  that's the migration's payoff) and its host note when it has one (parity
 *  with the old `node_id = ANY(visible)` filter). */
export async function taskRowsForBootstrap(workspaceId: string, visibleNodeIds: string[]): Promise<TaskRow[]> {
  if (visibleNodeIds.length === 0) return [];
  const r = await q<TaskRow>(
    `${TASK_ROW_SELECT}
      ${TASK_HOST_JOIN_SQL}
      WHERE t.workspace_id = $1 AND ${liveNodeSql("t")}
        AND ${TASK_HOST_LIVE_WHERE}
        -- IN (SELECT unnest) hashes the id set once. As = ANY($2) it was a
        -- per-row filter scanning the whole array: quadratic in the
        -- workspace's readable notes (1.9 s at 5.8k, 10 ms this way). The
        -- same holds for taskRowsByIds and taskNodeIdsAmong below/above.
        AND t.id IN (SELECT unnest($2::uuid[]))
        AND (t.parent_id IS NULL OR t.parent_id IN (SELECT unnest($2::uuid[])))
      ORDER BY t.created_at ASC`,
    [workspaceId, visibleNodeIds],
  );
  return r.rows;
}

/** Which of `ids` are task nodes? Includes soft-deleted nodes on purpose —
 *  sync.ts classifies NODE_DELETED targets with this, and a deleted task must
 *  land in tasks.delete (not pollute nodes.delete). */
export async function taskNodeIdsAmong(workspaceId: string, rawIds: string[]): Promise<Set<string>> {
  // Event target_ids are strings; tolerate non-uuid targets (the ::uuid[] cast
  // would throw) by filtering to uuid-shaped ones first.
  const ids = rawIds.filter(isUuid);
  if (ids.length === 0) return new Set();
  const r = await q<{ id: string }>(
    `SELECT t.id FROM content_nodes t
      WHERE t.workspace_id = $1 AND t.id IN (SELECT unnest($2::uuid[])) AND ${hasTaskRefSql("t")}`,
    [workspaceId, ids],
  );
  return new Set(r.rows.map((row) => row.id));
}

/** The word a NEW task line is written with in this workspace (`{word}`): the title of the tasks module's tag while that
 *  tag node exists (a workspace whose tag was renamed, or named `任務` because a plain `task` tag was there first); with
 *  no module tag, `task` — or `任務` when a plain `task` tag of the user's is there, whose `{task}` must stay a tag.
 *  seam.lineWords recognises the same words. Goes away with the tag node (the last PR of function-refs batch 3). */
export async function taskLineWord(workspaceId: string): Promise<string> {
  const { names, otherTagNamed } = await functionTagNames(workspaceId, TASK_FUNCTION_ID, TASK_TAG_NAME);
  return names[0] ?? (otherTagNamed ? TASK_WORD_WHEN_TASK_IS_A_TAG : TASK_TAG_NAME);
}

/** The word used when the user's own tag already has the name `task` and the workspace has no tasks module tag. */
export const TASK_WORD_WHEN_TASK_IS_A_TAG = "任務";

/** The reserved `_task_*` attributes of a new task, all optional but status. */
export type TaskFields = {
  status?: string;
  when?: string | null;
  evening?: boolean;
  someday?: boolean;
  deadline?: string | null;
  recur?: string | null;
  recurMode?: RecurMode | null;
  remindAt?: string | null;
  time?: string | null;
  until?: string | null;
  /** ISO instant; a task created done without one is stamped now. */
  doneAt?: string | null;
};

/** The task fields held by a task node's attributes, read from either
 *  generation: backups made before migration 135 carry `_task_due` (a day,
 *  maybe with a time of day that becomes the reminder) and status `later`
 *  (parked: todo + someday). `status` is "todo" when the node has none. */
export function taskFieldsOfAttributes(attributes: ReadonlyArray<{ key: string; value: string }>): TaskFields & { status: string } {
  const get = (key: string) => attributes.find((a) => a.key === key)?.value ?? null;
  const legacyDue = get("_task_due");
  const status = get(K.status) ?? "todo";
  const mode = get(K.recurMode);
  return {
    status: status === "later" ? "todo" : status,
    when: get(K.when) ?? (legacyDue ? legacyDue.slice(0, 10) : null),
    evening: get(K.evening) === "true",
    someday: get(K.someday) === "true" || status === "later",
    deadline: get(K.deadline),
    recur: get(K.recur),
    recurMode: mode === "after" ? "after" : null,
    remindAt: get(K.remindAt) ?? (legacyDue?.includes("T") ? legacyDue : null),
    time: get(K.time),
    until: get(K.until),
    doneAt: get(K.doneAt),
  };
}

/** What a new note's text brings with it (links, anchors, backup): services/newNoteDerived finishNewNote. */
type FinishNewNote = typeof finishNewNote;

/** Raw inserts for one task node (node + tasks reference + attrs). Runs via q() so it
 *  joins whatever transaction is open — a mutate() apply, or the scheduler's
 *  per-task tx. The caller owns event emission. `hostId` null makes a
 *  standalone task in `spaceId`; with a host the database keeps it in the
 *  host's space. */
export async function insertTaskNodeTx(opts: TaskFields & {
  workspaceId: string;
  id: string;
  hostId: string | null;
  spaceId?: string | null;
  title: string;
  /** The details text it starts with (the next occurrence of a repeating task copies the one before). Needs `bodyFrom`. */
  markdown?: string;
  /** Who makes it and in which event: what the text gives a new note (links, backup, search) follows them. `finish` is
   *  services/newNoteDerived finishNewNote, handed in by the caller (importing it here would close an import cycle). */
  bodyFrom?: { eventId: string; actor: ActorCtx; finish: FinishNewNote };
}): Promise<void> {
  const markdown = opts.markdown && opts.bodyFrom ? opts.markdown : "";
  // The task's first version (spine/noteVersions.ts), its text stored first as every save does (services/blobs.ts); most tasks have no text,
  // and the empty text is stored once for every note, so that case takes no second connection.
  const bodyHash = await storedTaskBody(markdown);
  await q(
    `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden, space_id)
     VALUES ($1, $2, 'manual', 'content', $3, $4, $7, $5, true, $6)`,
    [opts.id, opts.workspaceId, opts.title, `task-${opts.id}`, opts.hostId, opts.hostId ? null : (opts.spaceId ?? null), markdown],
  );
  await recordVersion({ workspaceId: opts.workspaceId, noteId: opts.id, unit: "body", contentHash: bodyHash, kind: "created", title: opts.title });
  await addTaskRefTx(opts.workspaceId, opts.id);
  const status = opts.status ?? "todo";
  await setTaskAttrTx(opts.workspaceId, opts.id, K.status, status);
  await setTaskFieldsTx(opts.workspaceId, opts.id, { ...opts, doneAt: status === "done" ? opts.doneAt ?? new Date().toISOString() : undefined });
  if (markdown && opts.bodyFrom) {
    const { finish, ...from } = opts.bodyFrom;
    await finish({ workspaceId: opts.workspaceId, nodeId: opts.id, title: opts.title, slug: `task-${opts.id}`, markdown }, from);
  }
}

/** Make `nodeId` a task node: it references the tasks function. The caller's NODE_CREATED event records
 *  the creation, so the reference has no event of its own (a task is not something a person adds or removes
 *  as a function). A hidden system row; the id is the database's default. Joins the caller's transaction. */
export async function addTaskRefTx(workspaceId: string, nodeId: string): Promise<void> {
  await insertFunctionRefs(workspaceId, nodeId, [{ functionId: TASK_FUNCTION_ID, sourceTagId: nodeId }]);
}

/** Write the optional `_task_*` fields that are given (a value sets, null
 *  clears, undefined leaves). Flags are stored as "true" and absent when off. */
export async function setTaskFieldsTx(workspaceId: string, id: string, fields: Omit<TaskFields, "status">): Promise<void> {
  const text: [string, string | null | undefined][] = [
    [K.when, fields.when], [K.deadline, fields.deadline], [K.recur, fields.recur],
    [K.recurMode, fields.recurMode === "fixed" ? null : fields.recurMode], [K.remindAt, fields.remindAt],
    [K.time, fields.time], [K.until, fields.until], [K.doneAt, fields.doneAt],
  ];
  const flags: [string, boolean | undefined][] = [[K.evening, fields.evening], [K.someday, fields.someday]];
  for (const [key, value] of text) if (value !== undefined) await setTaskAttrTx(workspaceId, id, key, value);
  for (const [key, on] of flags) if (on !== undefined) await setTaskAttrTx(workspaceId, id, key, on ? "true" : null);
}

/** The hash of a task's text, stored (services/blobs.ts putBlob). The empty text, which nearly every task has, is looked up in this transaction
 *  first: once stored it is never collected while a version or an event names it, so putting it again would only cost a second connection. */
async function storedTaskBody(markdown: string): Promise<string> {
  if (markdown === "") {
    const empty = await db.selectFrom("blobs").select("hash").where("hash", "=", EMPTY_BODY_HASH).executeTakeFirst();
    if (empty) return empty.hash;
  }
  return putBlob(markdown);
}
const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha-256 of the empty text

/** Rename a task node (inside the caller's NODE_UPDATED mutate): a version of the task when the title changes (spine/noteVersions.ts). */
export async function setTaskTitleTx(id: string, title: string): Promise<void> {
  const before = await db.selectFrom("content_nodes").select(["workspace_id", "title", "markdown"]).where("id", "=", id).executeTakeFirst();
  await q(`UPDATE content_nodes SET title = $2, updated_at = now() WHERE id = $1`, [id, title]);
  if (before && before.title !== title) {
    await recordVersion({ workspaceId: before.workspace_id, noteId: id, unit: "body", contentHash: await storedTaskBody(before.markdown), kind: "updated", title });
  }
}

/** Upsert (value) or delete (null) one reserved `_task_*` attribute row.
 *  Event emission is the caller's job — routes wrap this in an ATTRIBUTE_SET /
 *  ATTRIBUTE_DELETED mutate(), the scheduler's mutate() wraps it. */
async function setTaskAttrTx(
  workspaceId: string,
  nodeId: string,
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await q(`DELETE FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key]);
    return;
  }
  // No schema field governs a `_task_` key: its type follows the value
  // (@onden/markdown freeFormType), so a day is stored as a date.
  await q(
    `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, false, 'ui', now())
     ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value, value_type = EXCLUDED.value_type, updated_at = now()`,
    [workspaceId, nodeId, key, value, freeFormType(value)],
  );
}

/** Close a task as cancelled (inside the caller's transaction). The one state
 *  write of the scheduler's "break" — a missed occurrence — which has no actor and
 *  runs as the task-scheduler system job inside its TASK_OCCURRENCE_MISSED
 *  mutate (modules/tasks/scheduler.ts); every actor-driven change goes through
 *  updateTask. */
export async function cancelTaskTx(workspaceId: string, taskId: string): Promise<void> {
  await setTaskAttrTx(workspaceId, taskId, K.status, "cancelled");
}

/** Whether this task already minted its next occurrence (a NODE_CREATED event whose `rolled_from` is the task), whether
 *  by its own tick or the scheduler, and whether or not that occurrence still exists. The event log keeps the link after
 *  a delete, so a deleted next occurrence is not recreated by a later tick. Serves a boolean only. */
export async function taskMintedNextOccurrence(workspaceId: string, taskId: string): Promise<boolean> {
  // Written to match the partial index domain_events_rolled_from_idx (migration 184): the event type as a literal.
  const found = await db.selectFrom("domain_events").select("id")
    .where("workspace_id", "=", workspaceId).where(sql<boolean>`event_type = 'NODE_CREATED'`)
    .where(sql<string>`payload->>'rolled_from'`, "=", taskId).limit(1).executeTakeFirst();
  return found !== undefined;
}

/** The id the occurrence after `previousId` has, whether or not it exists (derived: migration 201). */
function successorTaskIdOf(previousId: string): string {
  return derivedId(derivedIdName.taskSuccessor(previousId));
}

/** The details text of a task node (its body); '' when it has none. */
export async function taskBodyMarkdown(taskId: string): Promise<string> {
  const row = await db.selectFrom("content_nodes").select("markdown").where("id", "=", taskId).executeTakeFirst();
  return row?.markdown ?? "";
}

/** The next occurrence of `taskId` when one is made and still there (the line may follow it), else null. */
export async function liveSuccessorTaskId(taskId: string): Promise<string | null> {
  const id = successorTaskIdOf(taskId);
  const found = await db.selectFrom("content_nodes").select("id").where("id", "=", id).where(sql<boolean>`${sql.raw(liveNodeSql())}`).executeTakeFirst();
  return found ? id : null;
}

/** When a task is open again (its completion or its missed roll undone): the occurrence its note's line may have moved on
 *  to, so the line can come back (services/blockNodes moveTaskLine); null when the task is not there any more. */
export async function successorOfReopenedTask(workspaceId: string, taskId: string): Promise<string | null> {
  const task = await db.selectFrom("content_nodes").select("id").where("id", "=", taskId).where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`${sql.raw(liveNodeSql())}`).executeTakeFirst();
  return task ? successorTaskIdOf(taskId) : null;
}

/** The id of the occurrence that follows `previousId` (completed or missed): derived from it, so two nodes that each make
 *  the next occurrence (a completion on one device, the scheduler on another) make the same task. Null when a task with
 *  that id exists already: the next occurrence was made, here or on another node, and is not made twice. */
export async function successorTaskId(previousId: string): Promise<string | null> {
  const id = successorTaskIdOf(previousId);
  const taken = await db.selectFrom("content_nodes").select("id").where("id", "=", id).executeTakeFirst();
  return taken ? null : id;
}

/** Spine-create one task node: NODE_CREATED + node + tasks reference + attrs, one
 *  attributed transaction. Used by POST /api/nodes/:id/tasks and POST
 *  /api/tasks (standalone) and — NESTED, so it chains via triggered_by and
 *  inherits the root actor — by the break-or-make "make" mint inside a
 *  completion's mutate().
 *
 *  Authority: write on the host note; with no host, write in the task's space
 *  (`spaceId`, which the caller has chosen by the rule every new top-level
 *  node follows — spaces.newNoteSpace — and which the spine checks again). */
export async function createTaskNode(opts: TaskFields & {
  workspaceId: string;
  actor: ActorCtx;
  /** The note the task is a line of or was added under; null = standalone. */
  hostId: string | null;
  /** Standalone only (hostId null): the space it lives in. */
  spaceId?: string | null;
  /** Client-minted task-node id (offline-parity). Absent → server mints. */
  id?: string;
  title: string;
  /** The details text it starts with (the next occurrence of a repeating task copies it); written only with `finishBody`. */
  markdown?: string;
  /** services/newNoteDerived finishNewNote, when `markdown` is given (see insertTaskNodeTx bodyFrom). */
  finishBody?: FinishNewNote;
  /** Extra NODE_CREATED payload fields (e.g. rolled_from for minted occurrences). */
  payloadExtra?: Record<string, unknown>;
  uiContext?: string;
}): Promise<string> {
  const id = opts.id ?? randomUUID();
  const { workspaceId, hostId, spaceId } = opts;
  if (!hostId && !spaceId) throw new Error("a standalone task needs its space");
  return withEventTransaction(workspaceId, async () => {
    await mutate({
      actor: opts.actor,
      workspaceId,
      authority: hostId
        ? { kind: "node", nodeId: hostId, op: "write_node" }
        : { kind: "space_write", spaceId: spaceId! },
      event: {
        type: "NODE_CREATED",
        targetType: "node",
        targetId: id,
        payload: {
          node_id: hostId,
          title: opts.title,
          when_date: opts.when ?? null,
          due_date: opts.when ?? null,
          recur: opts.recur ?? null,
          task: true,
          ...(!hostId ? { space_id: spaceId } : {}),
          ...(opts.payloadExtra ?? {}),
        },
        txMeta: { inverse_op: "node.deleted", ui_context: opts.uiContext ?? "task.create" },
      },
      apply: async ({ eventId }) => {
        await insertTaskNodeTx({ ...opts, id, ...(opts.markdown && opts.finishBody ? { bodyFrom: { eventId, actor: opts.actor, finish: opts.finishBody } } : {}) });
      },
    });
    return id;
  });
}

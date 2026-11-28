// Focus records (docs/architecture/day-timeline.md, 專注紀錄): the times a
// person spent focused — on a task or on nothing in particular — kept so the
// day's timeline can show them and the one sentence written when it ended can
// go into the day's note and under the task. Data and API only; the timer is
// the app's.
//
//   startFocus   (POST  /api/tasks/focus)             begin one (the client mints `id`; a replay answers it)
//   endFocus     (POST  /api/tasks/focus/:id/end)     end it, with a sentence and where to write it
//   editFocus    (PATCH /api/tasks/focus/:id)         fix times (forgot to stop), the sentence or the task
//   focusOfDay   (GET   /api/tasks/focus?day=)        a day's records, and the one still running
//
// The row (focus_sessions, migration 148) is the state; each change is also a
// domain event (FOCUS_STARTED / FOCUS_ENDED / FOCUS_EDITED) in the same
// transaction, with the task and the times but never the sentence. A record
// is its owner's: another member's id answers 404. Events about it are seen by
// the owner of the workspace and the person it belongs to (eventVisibility).
// There is no undo of a record: editing it is the correction.

import { z } from "zod";
import { localDateTimeId, localDayId, sqlLocalDay } from "../../localDay.js";
import { getWorkspaceId, q, withSavepoint } from "../../db.js";
import { mutate, requireActor } from "../../spine/mutate.js";
import { assertAuthority, AuthorityError, personalDataOwnerId, isTemporarySessionActor, requirePerson } from "../../spine/authority.js";
import { readableAmong } from "../../services/readPolicy.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { appendedBody } from "@onden/markdown";
import { appendToDayNote } from "../../services/dayNotes.js";
import { NodeUpdateError, updateNode } from "../../services/nodeUpdate.js";
import { taskRowById } from "../../services/tasksStore.js";
import type { ActorCtx } from "../../types.js";
import { whenDateField } from "./fields.js";
import { TaskUpdateRefusal } from "./update.js";
import type { FocusSession } from "@onden/contract";

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "an ISO time, e.g. 2026-10-30T09:30:00Z").transform((value) => new Date(value).toISOString());

export const startFocusSchema = z.object({
  /** Client-minted so a retry after a lost answer finds the record it made. */
  id: z.string().uuid().optional(),
  task_id: z.string().uuid().nullish(),
  /** Default: now. A past time starts it as if begun then. */
  started_at: instant.optional(),
});
export const endFocusSchema = z.object({
  /** Default: now. */
  ended_at: instant.optional(),
  /** What was done, one sentence. */
  note: z.string().trim().max(500).optional(),
  /** Also write it as a quote line in the day's note of the day it began. */
  to_diary: z.boolean().optional(),
  /** Also write it as a line under the task (its own text). */
  to_task: z.boolean().optional(),
});
export const editFocusSchema = z.object({
  started_at: instant.optional(),
  /** Only a record that has ended has an end to move; end a running one with endFocus. */
  ended_at: instant.optional(),
  note: z.string().trim().max(500).optional(),
  task_id: z.string().uuid().nullable().optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined), "nothing to change");
export const focusDaySchema = z.object({ day: whenDateField.optional() });

type FocusRow = { id: string; actor_id: string; task_id: string | null; started_at: Date; ended_at: Date | null; note: string };
const COLUMNS = `id::text, actor_id::text, task_id::text, started_at, ended_at, note`;
const toSession = (row: FocusRow): FocusSession => ({
  id: row.id, task_id: row.task_id, started_at: row.started_at.toISOString(), ended_at: row.ended_at?.toISOString() ?? null, note: row.note,
});

/** The longest one record may be: past this the end was forgotten, not reached. */
const MAX_FOCUS_MS = 24 * 3_600_000;
/** A clock a little ahead of the server's is not a future time. */
const CLOCK_SLACK_MS = 60_000;

const refuse = (status: 400 | 404 | 409, error: string): never => { throw new TaskUpdateRefusal(status, error); };

function assertTimes(startedAt: Date, endedAt: Date | null): void {
  if (startedAt.getTime() > Date.now() + CLOCK_SLACK_MS) refuse(400, "focus_in_future");
  if (endedAt === null) return;
  if (endedAt.getTime() > Date.now() + CLOCK_SLACK_MS) refuse(400, "focus_in_future");
  if (endedAt < startedAt) refuse(400, "focus_ends_before_it_starts");
  if (endedAt.getTime() - startedAt.getTime() > MAX_FOCUS_MS) refuse(400, "focus_too_long");
}

/** The task a record may name: one the person can read. */
async function assertTaskReadable(actor: ActorCtx, workspaceId: string, taskId: string): Promise<void> {
  if (!(await taskRowById(workspaceId, taskId))) refuse(404, "task not found");
  await assertAuthority(actor, { kind: "node", nodeId: taskId, op: "read" });
}

async function ownRow(actor: ActorCtx, id: string): Promise<FocusRow> {
  const row = (await q<FocusRow>(`SELECT ${COLUMNS} FROM focus_sessions WHERE id = $1 AND actor_id = $2 FOR UPDATE`, [id, actor.id])).rows[0];
  return row ?? refuse(404, "focus_not_found");
}

/** Begin a focus record. Refusals: 409 `focus_running` (one is running; end it
 *  first), 409 `id_conflict` (the id is another person's), 404 task not found,
 *  400 `focus_in_future`. A replay of the same id answers the record it made. */
export async function startFocus(authenticated: ActorCtx | null, input: z.infer<typeof startFocusSchema>): Promise<FocusSession> {
  const workspaceId = await getWorkspaceId();
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    requirePerson(actor, "focus"); // a focus record is its person's own: a temporary session never writes one (these writes go through mutate, not mutatePersonal)
    const id = input.id ?? crypto.randomUUID();
    const replay = (await q<FocusRow>(`SELECT ${COLUMNS} FROM focus_sessions WHERE id = $1`, [id])).rows[0];
    if (replay) return replay.actor_id === actor.id ? toSession(replay) : refuse(409, "id_conflict");
    if (input.task_id) await assertTaskReadable(actor, workspaceId, input.task_id);
    const running = (await q(`SELECT 1 FROM focus_sessions WHERE actor_id = $1 AND ended_at IS NULL`, [actor.id])).rows[0];
    if (running) refuse(409, "focus_running");
    const startedAt = input.started_at ? new Date(input.started_at) : new Date();
    assertTimes(startedAt, null);
    return mutate({
      actor, workspaceId, authority: { kind: "any_space_write" },
      event: {
        type: "FOCUS_STARTED", targetType: "focus_session", targetId: id,
        payload: { task_id: input.task_id ?? null, started_at: startedAt.toISOString() },
        txMeta: { ui_context: "focus.start" },
      },
      apply: async () => toSession((await q<FocusRow>(
        `INSERT INTO focus_sessions (id, workspace_id, actor_id, task_id, started_at) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [id, workspaceId, actor.id, input.task_id ?? null, startedAt])).rows[0]!),
    });
  });
}

/** "09:30–10:25 專注〈交報告〉：寫完第二段": the line the sentence becomes. */
function focusLine(row: FocusRow, endedAt: Date, title: string | null, note: string): string {
  const time = (at: Date) => localDateTimeId(at).slice(11, 16);
  return `${time(row.started_at)}–${time(endedAt)} 專注${title ? `〈${title}〉` : ""}：${note}`;
}

/** End a focus record at `ended_at` (default now) with an optional sentence.
 *  Without `ended_at`, a record open longer than 24 hours ends at 24 hours.
 *  Ending a record that has ended answers it unchanged (a retried request).
 *  With a sentence, `to_diary` quotes it in the day's note and `to_task` adds
 *  it under the task; each is tried on its own, and `written` says which
 *  landed — a note or task the person may no longer write does not stop the
 *  record from ending. Refusals: 404 `focus_not_found`, 400 on a bad time. */
export async function endFocus(authenticated: ActorCtx | null, id: string, input: z.infer<typeof endFocusSchema>): Promise<FocusSession & { written: { diary: boolean; task: boolean } }> {
  const workspaceId = await getWorkspaceId();
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    requirePerson(actor, "focus"); // a focus record is its person's own: a temporary session never writes one (these writes go through mutate, not mutatePersonal)
    const row = await ownRow(actor, id);
    const written = { diary: false, task: false };
    if (row.ended_at) return { ...toSession(row), written };
    // No end sent: now, but a record left open past the limit ends at the limit
    // (the person forgot to stop it; refusing would leave it running forever).
    // An end the client sent is judged as sent.
    const endedAt = input.ended_at ? new Date(input.ended_at) : new Date(Math.min(Date.now(), row.started_at.getTime() + MAX_FOCUS_MS));
    assertTimes(row.started_at, endedAt);
    const note = input.note ?? row.note;
    const ended = await mutate({
      actor, workspaceId, authority: { kind: "any_space_write" },
      event: {
        type: "FOCUS_ENDED", targetType: "focus_session", targetId: id,
        payload: { task_id: row.task_id, started_at: row.started_at.toISOString(), ended_at: endedAt.toISOString() },
        txMeta: { ui_context: "focus.end" },
      },
      apply: async () => (await q<FocusRow>(
        `UPDATE focus_sessions SET ended_at = $2, note = $3, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, endedAt, note])).rows[0]!,
    });
    if (note !== "" && (input.to_diary || input.to_task)) {
      const title = row.task_id ? (await taskRowById(workspaceId, row.task_id))?.title ?? null : null;
      const line = focusLine(row, endedAt, title, note);
      const attempt = async (write: () => Promise<boolean>): Promise<boolean> => {
        try { return await withSavepoint(write); }
        catch (error) {
          if (error instanceof AuthorityError || error instanceof NodeUpdateError) return false;
          throw error;
        }
      };
      if (input.to_diary) written.diary = await attempt(() => appendToDayNote(actor, workspaceId, localDayId(row.started_at), `> ${line}`));
      if (input.to_task && row.task_id) {
        const taskId = row.task_id;
        written.task = await attempt(async () => {
          const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1 FOR UPDATE`, [taskId])).rows[0]?.markdown;
          if (body === undefined) return false;
          await updateNode(workspaceId, taskId, { markdown: appendedBody(body, line) }, {
            actor, baseMarkdown: body,
            event: { uiContext: "focus.task", cascadeLabel: "focus.task.cascade", backupPrefix: "FOCUS_TASK" },
          });
          return true;
        });
      }
    }
    return { ...toSession(ended), written };
  });
}

/** Change a record's times, sentence or task. Refusals: 404 `focus_not_found`,
 *  400 `focus_ends_before_it_starts` / `focus_too_long` / `focus_in_future`,
 *  400 `focus_still_running` (an end for a record that has none), 404 task. */
export async function editFocus(authenticated: ActorCtx | null, id: string, input: z.infer<typeof editFocusSchema>): Promise<FocusSession> {
  const workspaceId = await getWorkspaceId();
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    requirePerson(actor, "focus"); // a focus record is its person's own: a temporary session never writes one (these writes go through mutate, not mutatePersonal)
    const row = await ownRow(actor, id);
    if (input.ended_at !== undefined && row.ended_at === null) refuse(400, "focus_still_running");
    const startedAt = input.started_at ? new Date(input.started_at) : row.started_at;
    const endedAt = input.ended_at ? new Date(input.ended_at) : row.ended_at;
    assertTimes(startedAt, endedAt);
    const taskId = input.task_id === undefined ? row.task_id : input.task_id;
    if (taskId && taskId !== row.task_id) await assertTaskReadable(actor, workspaceId, taskId);
    const note = input.note ?? row.note;
    return mutate({
      actor, workspaceId, authority: { kind: "any_space_write" },
      event: {
        type: "FOCUS_EDITED", targetType: "focus_session", targetId: id,
        payload: { task_id: taskId, started_at: startedAt.toISOString(), ended_at: endedAt?.toISOString() ?? null },
        txMeta: { ui_context: "focus.edit" },
      },
      apply: async () => toSession((await q<FocusRow>(
        `UPDATE focus_sessions SET started_at = $2, ended_at = $3, note = $4, task_id = $5, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, startedAt, endedAt, note, taskId])).rows[0]!),
    });
  });
}

/** The records that began on `day` (default today, on the workspace clock),
 *  oldest first, and the one still running whatever day it began. Only the
 *  person's own; a temporary session reads its person's (personalDataOwnerId),
 *  minus the records on a task it cannot read (the task's id and the sentence
 *  written about it are not for a computer that has no access to the task) and
 *  minus the sentence of a record on no task (time and length only). */
export async function focusOfDay(authenticated: ActorCtx | null, input: z.infer<typeof focusDaySchema>): Promise<{ day: string; sessions: FocusSession[]; running: FocusSession | null }> {
  const actor = requireActor(authenticated);
  const owner = personalDataOwnerId(actor);
  const day = input.day ?? localDayId();
  const found = (await q<FocusRow>(
    `SELECT ${COLUMNS} FROM focus_sessions WHERE actor_id = $1 AND ${sqlLocalDay("started_at")} = $2 ORDER BY started_at, id`, [owner, day])).rows;
  // the later running record where a merge kept two (decision 4.4: the earlier one counts as ended when the next began; migration 236); on one node there is one
  const runningRow = (await q<FocusRow>(`SELECT ${COLUMNS} FROM focus_sessions WHERE actor_id = $1 AND ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1`, [owner])).rows[0];
  let rows = found;
  let running: FocusRow | undefined = runningRow;
  if (isTemporarySessionActor(actor)) {
    const readable = await readableAmong(actor, await getWorkspaceId(), [...found, ...(runningRow ? [runningRow] : [])].flatMap((row) => row.task_id ? [row.task_id] : []));
    const keep = (row: FocusRow) => row.task_id === null || readable.has(row.task_id);
    // A record on no task has a sentence nothing ties to a space it may read: the session gets its time and length only.
    const timeOnly = (row: FocusRow): FocusRow => (row.task_id === null ? { ...row, note: "" } : row);
    rows = found.filter(keep).map(timeOnly);
    running = runningRow && keep(runningRow) ? timeOnly(runningRow) : undefined;
  }
  return { day, sessions: rows.map(toSession), running: running ? toSession(running) : null };
}

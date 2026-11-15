// Creating a task: a standalone one (POST /api/tasks) or one added under a
// note (POST /api/nodes/:id/tasks). Both take the same fields and go through
// services/tasksStore createTaskNode — one NODE_CREATED, attributed, with the
// task's fields, in the same transaction as the first-use creation of the
// tasks module's tag.

import { z } from "zod";
import { getWorkspaceId, q, withTransaction } from "../../db.js";
import { requireActor } from "../../spine/mutate.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { canReadNode } from "../../services/readPolicy.js";
import { newNoteSpace } from "../../services/spaces.js";
import { createTaskNode, taskRowById, type TaskFields, type TaskRow } from "../../services/tasksStore.js";
import type { ActorCtx } from "../../types.js";
import { deadlineField, dueDateField, recurField, recurModeField, remindAtField, sameDay, SAME_DAY_MESSAGE, timeField, titleField, UNTIL_MESSAGE, untilAfterTime, whenDateField } from "./fields.js";
import { placeTask, placeTaskSchema } from "./placement.js";
import { taskDayFromLegacyDue } from "./recurrence.js";
import { TaskUpdateRefusal } from "./update.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

const createFields = {
  title: titleField,
  // Offline-parity: the client mints the task-node id so an optimistic task
  // carries a STABLE id (reconciled by /api/sync on the same id, no transient
  // duplicate). Absent → server mints. A replay with the same id returns the
  // task it made.
  id: z.string().uuid().optional(),
  when_date: whenDateField.nullish(),
  due_date: dueDateField.nullish(),
  evening: z.boolean().nullish(),
  someday: z.boolean().nullish(),
  deadline: deadlineField.nullish(),
  recur: recurField.nullish(),
  recur_mode: recurModeField.nullish(),
  remind_at: remindAtField.nullish(),
  /** HH:MM it starts, and when it ends (later than the start; no end without a start). */
  time: timeField.nullish(),
  until: timeField.nullish(),
};

const untilNeedsTime = ({ time, until }: { time?: string | null; until?: string | null }): boolean => typeof until !== "string" || typeof time === "string";
const UNTIL_NEEDS_TIME = "until needs a time";

/** POST /api/tasks: a task born standalone. `space_id` names its space
 *  (default the creator's personal space). With `into` it is written into that
 *  note as a checkbox line as it is made (placement.ts placeTask, in the same
 *  transaction: the task is never left standalone when the note refuses it),
 *  and lives in the note's space. */
export const standaloneTaskSchema = z.object({ ...createFields, space_id: z.string().uuid().optional(), into: placeTaskSchema.optional() })
  .refine(sameDay, SAME_DAY_MESSAGE).refine(untilAfterTime, UNTIL_MESSAGE).refine(untilNeedsTime, UNTIL_NEEDS_TIME);
/** POST /api/nodes/:id/tasks: a task under a note (in the note's space). */
export const hostedTaskSchema = z.object(createFields)
  .refine(sameDay, SAME_DAY_MESSAGE).refine(untilAfterTime, UNTIL_MESSAGE).refine(untilNeedsTime, UNTIL_NEEDS_TIME);
export type StandaloneTaskInput = z.infer<typeof standaloneTaskSchema>;

/** The request's fields as the task's attributes (older `due_date` folded in). */
export function taskFieldsOf(input: z.infer<typeof hostedTaskSchema>): TaskFields {
  const legacy = input.due_date ? taskDayFromLegacyDue(input.due_date) : null;
  return {
    when: input.when_date ?? legacy?.when ?? null,
    evening: input.evening === true,
    someday: input.someday === true,
    deadline: input.deadline ?? null,
    recur: input.recur ?? null,
    recurMode: input.recur_mode === "after" ? "after" : null,
    remindAt: input.remind_at ?? legacy?.remindAt ?? null,
    time: input.time ?? null,
    until: input.until ?? null,
  };
}

/** Make a task and return its row. `hostId` null = standalone. The tag is
 *  found or made first, in the same transaction, so a retry under one
 *  Idempotency-Key can never commit the tag and lose the task (H10). A replay
 *  whose id already names a task the caller can read answers that task. */
export async function createTask(
  authenticated: ActorCtx | null,
  input: StandaloneTaskInput,
  { hostId = null }: { hostId?: string | null } = {},
): Promise<TaskRow> {
  const actor = requireActor(authenticated);
  const workspaceId = await getWorkspaceId();
  const fields = taskFieldsOf(input);
  if (hostId) {
    // The host must be a live node — a task is born as its hidden child
    // (migration 062: tasks ARE nodes; the old node_id FK did this implicitly).
    const host = await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`, [workspaceId, hostId]);
    if (!host.rows[0]) throw new TaskUpdateRefusal(404, "node not found");
  }
  const taskId = await withTransaction(async () => {
    if (input.id) {
      const replay = await withEventTransaction(workspaceId, async () => {
        const row = await taskRowById(workspaceId, input.id!);
        if (row && await canReadNode(await resolveCurrentActor(actor, workspaceId), row.id)) return row.id;
        if (row || await idTaken(input.id!)) throw new TaskUpdateRefusal(409, "id_conflict");
        return null;
      });
      if (replay) return replay;
    }
    // A standalone task goes where any new top-level node goes: the space
    // named, else the creator's personal space (judged for the actor as they
    // are now, under the event lock); the spine checks write there again.
    const spaceId = hostId ? null : await withEventTransaction(workspaceId, async () =>
      newNoteSpace(await resolveCurrentActor(actor, workspaceId), workspaceId, { spaceId: input.space_id }));
    // Spine create: NODE_CREATED + node + tasks reference + _task_* attrs, attributed.
    // Authority: write on the host note, or in the space of a standalone task.
    const id = await createTaskNode({ ...fields, workspaceId, actor, hostId, spaceId, id: input.id, title: input.title });
    if (input.into && !hostId) await placeTask(actor, id, input.into);
    return id;
  });
  return (await taskRowById(workspaceId, taskId))!;
}

/** Any row at all (another workspace's too) holds the id. */
async function idTaken(id: string): Promise<boolean> {
  return (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [id])).rows.length > 0;
}

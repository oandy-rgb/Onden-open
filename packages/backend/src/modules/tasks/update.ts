// Updating a task (PATCH /api/tasks/:id, depth audit D13): status, the day to
// do it, evening, someday, deadline, repeat rule and mode, reminder and title,
// spine-mutated.

import { z } from "zod";
import { q, getWorkspaceId } from "../../db.js";
import { dayClock, localDayId } from "../../localDay.js";
import { recordAttributeChange } from "../../services/attributeChange.js";
import { mutate, requireActor } from "../../spine/mutate.js";
import { spendIdempotencyKey } from "../../spine/idempotency.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { assertAuthority } from "../../spine/authority.js";
import { K } from "../../spine/taskIdentity.js";
import { moveTaskLine } from "../../services/blockNodes.js";
import { finishNewNote } from "../../services/newNoteDerived.js";
import { taskRowById, taskMintedNextOccurrence, successorTaskId, createTaskNode, taskBodyMarkdown, liveSuccessorTaskId, setTaskTitleTx, type RecurMode, type TaskRow } from "../../services/tasksStore.js";
import { relinkTarget } from "../../services/wikilinkEdges.js";
import { taskLineChanged } from "../../services/taskLineHook.js";
import { TaskUpdateRefusal } from "../../services/taskSeam.js";
import type { ActorCtx } from "../../types.js";
import { TASK_STATUSES, type TaskStatus } from "@onden/markdown";
import { reminderAfterMove } from "@onden/markdown/contract";
import { nextOccurrence, taskDayFromLegacyDue } from "./recurrence.js";
import { deadlineField, dueDateField, recurField, recurModeField, remindAtField, sameDay, SAME_DAY_MESSAGE, timeField, UNTIL_MESSAGE, untilAfterTime, whenDateField } from "./fields.js";
import { TASK_TITLE_MAX } from "@onden/markdown";

/** The fields a task PATCH may carry. `null` clears a field (a flag cleared
 *  is off). `due_date` is the older name of `when_date`, which older clients
 *  and queued offline writes still send: a time of day in it becomes the
 *  reminder, and `status: "later"` (the old "parked") is todo + someday. */
export const taskPatchSchema = z.object({
    status: z.enum(TASK_STATUSES).optional(),
    when_date: whenDateField.nullable().optional(),
    due_date: dueDateField.nullable().optional(),
    evening: z.boolean().nullable().optional(),
    someday: z.boolean().nullable().optional(),
    deadline: deadlineField.nullable().optional(),
    recur: recurField.nullable().optional(),
    recur_mode: recurModeField.nullable().optional(),
    remind_at: remindAtField.nullable().optional(),
    /** HH:MM it starts, written on its line; `null` clears it (and its end). */
    time: timeField.nullable().optional(),
    until: timeField.nullable().optional(),
    title: z.string().min(1).max(TASK_TITLE_MAX).optional(),
}).refine(sameDay, SAME_DAY_MESSAGE).refine(untilAfterTime, UNTIL_MESSAGE);
export type TaskPatch = z.infer<typeof taskPatchSchema>;

/** The patch as the fields it changes: older names folded into current ones.
 *  `undefined` leaves a field alone; `null` clears it. */
type Changes = {
  title?: string; status?: TaskStatus;
  when?: string | null; evening?: boolean; someday?: boolean; deadline?: string | null;
  recur?: string | null; recurMode?: RecurMode | null; remindAt?: string | null;
  time?: string | null; until?: string | null;
};

export function changesOf(input: TaskPatch): Changes {
  const legacy = typeof input.due_date === "string" ? taskDayFromLegacyDue(input.due_date) : null;
  const parked = input.status === "later";
  return {
    title: input.title,
    status: parked ? "todo" : input.status,
    when: input.when_date !== undefined ? input.when_date : input.due_date === undefined ? undefined : legacy ? legacy.when : null,
    evening: input.evening === undefined ? undefined : input.evening === true,
    someday: input.someday !== undefined ? input.someday === true : parked ? true : undefined,
    deadline: input.deadline,
    recur: input.recur,
    recurMode: input.recur_mode as RecurMode | null | undefined,
    remindAt: input.remind_at !== undefined ? input.remind_at : legacy?.remindAt ?? undefined,
    time: input.time,
    until: input.until,
  };
}

export { TaskUpdateRefusal };

/** Apply `input` to task `id` and return the task row. Throws
 *  TaskUpdateRefusal (400 nothing to change, 404 no such task), an
 *  UnauthorizedError / AuthorityError as the spine decides.
 *
 *  Every changed field is its own invertible event (ATTRIBUTE_SET /
 *  ATTRIBUTE_DELETED on the reserved key; NODE_UPDATED for the title), all in
 *  ONE transaction — which is what makes an agent's task edit reviewable (and
 *  rejectable) in the inbox like any other node change.
 *
 *  Completing (status→done) a task that carries a recur rule mints the NEXT
 *  occurrence atomically: a new task node + its own NODE_CREATED event,
 *  cascaded off the completion ("make" of break-or-make; the scheduler handles
 *  "break"). Which day it falls on depends on the repeat mode
 *  (recurrence.ts nextOccurrence).
 */
export async function updateTask(authenticated: ActorCtx | null, id: string, input: TaskPatch, { fromLine = false }: {
  /** The change comes from the task's own line (modules/tasks/blockTasks.ts):
   *  its box and text are already what the patch says. */
  fromLine?: boolean;
} = {}) {
  const actor = requireActor(authenticated);
  const workspaceId = await getWorkspaceId();

  const changed = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  if (Object.keys(changed).length === 0) throw new TaskUpdateRefusal(400, "empty patch");
  const next = changesOf(input);

  // Task updates retain existing attribute metadata. Record that actual row,
  // including legacy provenance, so a restore does not silently change priority
  // (services/attributeChange.ts records the row actually written).
  const attrPatch = async (key: string, value: string | null, ui: string, afterWrite?: () => Promise<void>) => {
    await recordAttributeChange({
      workspaceId, nodeId: id, key, actor,
      next: value === null ? null : { value },
      rule: "always",
      authority: { kind: "node", nodeId: id, op: value === null ? "delete_attribute" : "set_attribute" },
      uiContext: ui,
      within: async () => { await afterWrite?.(); },
    });
  };

  const found = await withEventTransaction(workspaceId, async () => {
    // Lock ordering matches the scheduler: append lock, then task row. All
    // before values and recurrence inputs are re-read inside that transaction.
    await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [id, workspaceId]);
    const prev = await taskRowById(workspaceId, id);
    if (!prev) return false;
    // A same-value PATCH still returns the task. Authorize every requested
    // capability while holding the event lock, including unchanged fields.
    await assertAuthority(actor, { kind: "node", nodeId: id, op: "read" });
    const operations = new Set<"write_node" | "set_attribute" | "delete_attribute">();
    if (next.title !== undefined) operations.add("write_node");
    for (const value of [next.status, next.when, next.evening, next.someday, next.deadline, next.recur, next.recurMode, next.remindAt, next.time, next.until]) {
      if (value !== undefined) operations.add(value === null || value === false ? "delete_attribute" : "set_attribute");
    }
    for (const op of operations) await assertAuthority(actor, { kind: "node", nodeId: id, op });
    // A task that is a line of its note (B4) takes its title from that line.
    if (!fromLine && next.title !== undefined && next.title !== prev.title) {
      const line = await q("SELECT 1 FROM block_nodes WHERE task_id = $1 AND hidden_at IS NULL", [id]);
      if (line.rows.length) throw new TaskUpdateRefusal(409, "task_is_a_line");
    }
    const liveStatus = prev.status;
    if (next.title !== undefined && next.title !== prev.title) {
      await mutate({
        actor,
        workspaceId,
        authority: { kind: "node", nodeId: id, op: "write_node" },
        event: {
          type: "NODE_UPDATED",
          targetType: "node",
          targetId: id,
          payload: { title: next.title, task: true },
          txMeta: {
            inverse_op: "node.updated",
            prev_field_values: { title: prev.title },
            ui_context: "task.update",
          },
        },
        apply: async () => {
          await setTaskTitleTx(id, next.title!);
          // Notes that [[name]] the task by its old or new title.
          await relinkTarget(workspaceId, [id]);
        },
      });
    }
    // One attribute per field, only when it changes.
    const setText = async (key: string, value: string | null | undefined, before: string | null, ui: string) => {
      if (value !== undefined && value !== before) await attrPatch(key, value, ui);
    };
    const setFlag = async (key: string, value: boolean | undefined, before: boolean, ui: string) => {
      if (value !== undefined && value !== before) await attrPatch(key, value ? "true" : null, ui);
    };
    // The end only means something after a start: no start, no end; a start moved
    // to or past the end drops it.
    const timeAfter = next.time !== undefined ? next.time : prev.time;
    let untilAfter = timeAfter === null ? null : next.until !== undefined ? next.until : prev.until;
    if (untilAfter !== null && timeAfter !== null && untilAfter <= timeAfter) {
      if (next.until !== undefined && next.until !== null) throw new TaskUpdateRefusal(400, UNTIL_MESSAGE);
      untilAfter = null;
    }
    const timeChanged = timeAfter !== prev.time || untilAfter !== prev.until;
    // A reminder on the wall clock moves with its task's day and time; one set to an exact moment stays
    // (@onden/markdown reminderAfterMove). Only when this change names no reminder of its own.
    const remindAtAfter = next.remindAt !== undefined ? next.remindAt
      : reminderAfterMove(prev.remind_at, { when: prev.when_date, time: prev.time }, {
        when: next.when !== undefined ? next.when : prev.when_date, time: timeAfter,
      }, dayClock().dayStartHour);
    await setText(K.when, next.when, prev.when_date, "task.when");
    await setFlag(K.evening, next.evening, prev.evening, "task.evening");
    await setFlag(K.someday, next.someday, prev.someday, "task.someday");
    await setText(K.deadline, next.deadline, prev.deadline, "task.deadline");
    await setText(K.recur, next.recur, prev.recur, "task.recur");
    // fixed is the default and is stored as no value at all.
    const modeBefore = prev.recur_mode === "fixed" ? null : prev.recur_mode;
    const modeAfter = next.recurMode === "fixed" ? null : next.recurMode;
    await setText(K.recurMode, modeAfter, modeBefore, "task.recur_mode");
    await setText(K.remindAt, remindAtAfter, prev.remind_at, "task.remind_at");
    await setText(K.time, timeAfter, prev.time, "task.time");
    await setText(K.until, untilAfter, prev.until, "task.until");
    // Status LAST: the break-or-make "make" must see the patched day and rule.
    if (next.status !== undefined && next.status !== liveStatus) {
      // Mint the next occurrence once per task, ever (M9): only when the live (locked)
      // status was NON-terminal, and only when this task never minted one before. A
      // concurrent scheduler tick (status now 'cancelled') or an earlier tick of this
      // task (tick, reopen, tick again) already minted it — also when that one was
      // deleted since: it is not recreated, and reopening does not take it back (that
      // could delete edits made to it). The link is NODE_CREATED's `rolled_from`.
      const completing = next.status === "done" && liveStatus !== "done" && liveStatus !== "cancelled";
      await attrPatch(K.status, next.status, "task.status", async () => {
        // Break-or-make "make": completion of a recurring occurrence mints
        // the next one — a NESTED spine create, so it commits with the
        // completion, inherits the completing actor, and its NODE_CREATED
        // chains to the completion event via triggered_by.
        const recur = next.recur !== undefined ? next.recur : prev.recur;
        if (!completing || !recur) return;
        if (await taskMintedNextOccurrence(workspaceId, id)) {
          // Finished again after a reopen: nothing new is made, and the line goes on to the one that was.
          const made = await liveSuccessorTaskId(id);
          if (made) {
            await moveTaskLine(workspaceId, id, made);
            await taskLineChanged({ workspaceId, taskId: made, actor, status: "todo" });
          }
          return;
        }
        const mode: RecurMode = next.recurMode !== undefined ? next.recurMode ?? "fixed" : prev.recur_mode;
        const occurrence = nextOccurrence({
          when: next.when !== undefined ? next.when : prev.when_date,
          evening: next.evening ?? prev.evening,
          deadline: next.deadline !== undefined ? next.deadline : prev.deadline,
          remindAt: remindAtAfter,
          recur, recurMode: mode,
        }, localDayId());
        if (!occurrence) return;
        const successorId = await successorTaskId(id);
        if (!successorId) return; // another node made it already
        await createTaskNode({
          id: successorId,
          workspaceId,
          actor,
          hostId: prev.node_id,
          spaceId: prev.space_id,
          title: next.title ?? prev.title,
          when: occurrence.when,
          evening: occurrence.evening,
          deadline: occurrence.deadline,
          remindAt: occurrence.remindAt,
          recur,
          recurMode: mode === "fixed" ? null : mode,
          time: timeAfter,
          until: untilAfter,
          markdown: await taskBodyMarkdown(id),
          finishBody: finishNewNote,
          payloadExtra: { rolled_from: id },
          uiContext: "task.recur.mint",
        });
        // The line of its note stands for the occurrence that is current: it moves on to the new one, its box empty again.
        await moveTaskLine(workspaceId, id, successorId);
        await taskLineChanged({ workspaceId, taskId: successorId, actor, status: "todo" });
      });
    }
    // When it was completed: stamped as it becomes done, cleared as it stops being done.
    if (next.status !== undefined && next.status !== liveStatus) {
      if (next.status === "done") await attrPatch(K.doneAt, new Date().toISOString(), "task.done_at");
      else if (liveStatus === "done") await attrPatch(K.doneAt, null, "task.done_at");
    }
    // Its line follows (B4): the box ticked when done and open otherwise, the
    // time as written at the start of the text.
    const statusMoved = next.status !== undefined && next.status !== liveStatus;
    if (!fromLine && (statusMoved || timeChanged)) {
      await taskLineChanged({ workspaceId, taskId: id, actor, ...(statusMoved ? { status: next.status } : {}), ...(timeChanged ? { time: { time: timeAfter, until: untilAfter } } : {}) });
    }
    // A PATCH that changed nothing (same values) wrote nothing and claimed no key: spend it, or its retry after a lost reply
    // would apply the old values over a newer change from another device.
    await spendIdempotencyKey(workspaceId);
    return taskRowById(workspaceId, id);
  });
  if (!found) throw new TaskUpdateRefusal(404, "task not found");
  return found as TaskRow;
}

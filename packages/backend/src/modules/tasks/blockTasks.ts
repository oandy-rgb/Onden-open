// Task lines (docs/architecture/block-nodes.md, B4): a task list item whose
// own `{…}` carries the reserved #task tag —
//
//   - [ ] 寫下三個想培養的習慣 {task}
//
// — is a task. The line is a block node; its task is an ordinary task node
// (a hidden child of the note: the tasks tag + _task_status), linked by
// block_nodes.task_id, so Tasks, due dates, recurrence, reminders and sync
// treat it like any other task. This module keeps the task in step with the
// line on every save of the note (blockNodes.syncBlockNodes calls it):
//
//   - a new task line makes its task (open, or done when already ticked);
//   - ticking the box completes the task (a recurring one mints its next
//     occurrence, as completing it in Tasks does); unticking reopens it;
//   - the line's text is the task's title; a time at its start (`15:00–16:00`)
//     is the task's time and end, not part of the title;
//   - removing `{task}` or the line trashes the task; putting it back
//     restores it, due date and all (block nodes keep their data, 已決定 1).
//
// The other way — a status changed in Tasks ticks the box — is lines.ts.

import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { createTaskNode, taskRowById } from "../../services/tasksStore.js";
import { updateTask, type TaskPatch } from "./update.js";
import { trashNode, undeleteNode } from "../../services/nodeTrash.js";
import type { TaskLine } from "../../services/taskSeam.js";

import { TASK_TITLE_MAX, cutToUnits, parseLineTime } from "@onden/markdown";

// A standalone task being placed into a note (placement.ts) is written into the
// note as a new task line; the line's save must link THAT task rather than make
// a new one. placeTask names the line (note + `^id`) before the note is saved,
// inside the same transaction, and releases the name after.
const adopting = new Map<string, string>();

/** For the note's next save: the line `^ref` of `noteId` belongs to task
 *  `taskId`. Returns the release; call it once the note is saved. */
export function adoptTaskForLine(noteId: string, ref: string, taskId: string): () => void {
  const key = `${noteId}:${ref}`;
  adopting.set(key, taskId);
  return () => { adopting.delete(key); };
}

/** Bring the note's line-made tasks in step with its task lines. Call in the
 *  note's write transaction, after its block nodes are synced. */
export async function syncBlockTasks(opts: {
  workspaceId: string; noteId: string; actor: ActorCtx; lines: TaskLine[];
}): Promise<void> {
  const { workspaceId, noteId, actor, lines } = opts;
  const linked = new Map((await q<{ id: string; task_id: string; deleted: boolean; detached: boolean }>(
    `SELECT b.id::text, b.task_id::text, t.deleted_at IS NOT NULL AS deleted, b.detached_note_id IS NOT NULL AS detached
       FROM block_nodes b JOIN content_nodes t ON t.id = b.task_id
      WHERE b.workspace_id = $1 AND b.note_id = $2`, [workspaceId, noteId],
  )).rows.map((row) => [row.id, row]));
  if (!lines.length && !linked.size) return;

  const current = new Set<string>();
  for (const line of lines) {
    current.add(line.blockId);
    // The text may start with the time it happens: `15:00–16:00 跟組員討論`.
    const { time, until, rest } = parseLineTime(line.title.trim());
    const title = cutToUnits(rest.trim(), TASK_TITLE_MAX) || "…";
    let link = linked.get(line.blockId);
    const adopted = link ? undefined : adopting.get(`${noteId}:${line.ref}`);
    if (adopted) {
      await q("UPDATE block_nodes SET task_id = $2 WHERE id = $1", [line.blockId, adopted]);
      link = { id: line.blockId, task_id: adopted, deleted: false, detached: false };
    }
    if (!link) {
      const taskId = randomUUID();
      await createTaskNode({ workspaceId, actor, hostId: noteId, id: taskId, title, time, until, uiContext: "block.task.create" });
      await q("UPDATE block_nodes SET task_id = $2 WHERE id = $1", [line.blockId, taskId]);
      if (line.checked) await updateTask(actor, taskId, { status: "done" }, { fromLine: true });
      continue;
    }
    if (link.deleted) await undeleteNode(actor, workspaceId, link.task_id);
    const task = await taskRowById(workspaceId, link.task_id);
    if (!task) continue;
    const patch: TaskPatch = {};
    if (task.title !== title) patch.title = title;
    if (task.time !== time) patch.time = time;
    if (task.until !== until) patch.until = until;
    if (line.checked && task.status !== "done" && task.status !== "cancelled") patch.status = "done";
    if (!line.checked && task.status === "done") patch.status = "todo";
    if (Object.keys(patch).length) await updateTask(actor, link.task_id, patch, { fromLine: true });
  }
  // A line that is no longer a task line (tag or line removed): its task
  // goes to the trash with its data, and comes back with the line. A paragraph standing alone as a
  // note (detached_note_id) has no line here on purpose: its task stays, due date and all.
  for (const [blockId, link] of linked) {
    if (current.has(blockId) || link.deleted || link.detached) continue;
    await trashNode(actor, workspaceId, link.task_id, { uiContext: "block.task.removed" });
  }
}

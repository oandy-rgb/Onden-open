// The places core code needs the tasks module's behaviour, installed by
// modules/tasks at load. Core never imports a module (modules/README.md): a
// note save (blockNodes), a backup restore (backupRestore) and the nodes route
// call these, and where the module is off or not loaded they do nothing, so
// task data stays exactly as it is. A leaf module: types only, no imports of
// task code.

import type { ActorCtx } from "../types.js";

/** A task line in the saved body: its block node row, text and box. */
export type TaskLine = { blockId: string; ref: string; title: string; checked: boolean };

/** A task write refused on its own, with the status and error the API answers
 *  (400 nothing to change, 404 no such task, 409 a conflict). Lives here so
 *  core callers (backup restore) can count it as a refusal without importing
 *  the module. */
export class TaskUpdateRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly error: string) { super(error); this.name = "TaskUpdateRefusal"; }
}

/** What a task's line did with a delete or its undo: it handled it, or the task is no note's line and the caller does. */
export type TaskLineOutcome = "done" | "not_a_line";

export type TaskSeam = {
  /** The words (lower case, written without `#`) that make a checkbox line a task line in this workspace, whether or
   *  not the module is on: the reserved `task` and the current name of each live tasks module tag (a renamed tag is
   *  written `{任務}`). `task` is left out when the workspace has an ordinary tag of that name — `{task}` is that tag,
   *  as before migration 191. Never resolved to a tag. */
  lineWords(workspaceId: string): Promise<readonly string[]>;
  /** Whether a checkbox line carrying one of those words is a task in this
   *  workspace: false when the module is off here. The words are never resolved to a tag either way. The word written for a new task line is tasksStore.taskLineWord. */
  linesAreTasks(workspaceId: string): Promise<boolean>;
  /** Bring the note's line-made tasks in step with its task lines. Call in the
   *  note's write transaction, after its block nodes are synced. */
  syncLines(opts: { workspaceId: string; noteId: string; actor: ActorCtx; lines: TaskLine[] }): Promise<void>;
  /** Change fields of a task the way PATCH /api/tasks/:id does; throws what it throws. */
  updateTask(actor: ActorCtx, id: string, patch: Record<string, unknown>): Promise<unknown>;
  /** Delete task `id` as a line of its note: the line leaves the note and the task goes to the trash, one transaction
   *  (modules/tasks/deletion.ts). "not_a_line", nothing done, when the task is not a line of a note (or the module is off
   *  here): the caller deletes it as any node. */
  deleteTaskLine(actor: ActorCtx, id: string): Promise<TaskLineOutcome>;
  /** Undo that: the task back with its line. "not_a_line", nothing done, when the delete in force took no line out. */
  undeleteTaskLine(actor: ActorCtx, id: string): Promise<TaskLineOutcome>;
  /** `_task_*` attributes (by full key) split into those the task routes would
   *  accept and the keys they would refuse. Not gated on the module being on:
   *  a value stored now is read by the module whenever it is turned on. */
  splitValidFields(fields: Record<string, string>): { valid: Record<string, string>; invalid: string[] };
};

let seam: TaskSeam | null = null;

/** Install the tasks module's behaviour (modules/tasks/index.ts, once at load). */
export function installTaskSeam(next: TaskSeam): void {
  seam = next;
}

/** The installed behaviour; null when the tasks module is not loaded. */
export function taskSeam(): TaskSeam | null {
  return seam;
}

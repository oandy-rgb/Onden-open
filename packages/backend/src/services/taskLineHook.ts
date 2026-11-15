// The seam between a task and its line (block-nodes.md B4): a task made from
// `- [ ] 15:00 text {task}` has its box ticked or unticked when its status
// changes in Tasks, and its time rewritten when the time changes there.
// updateTask calls taskLineChanged inside its transaction; modules/tasks/lines.ts
// (which writes the note through the note save, and so sits above the
// block-node code updateTask must not import) installs the writer. A leaf
// module: no imports.

import type { ActorCtx } from "../types.js";

/** What changed on a task that its line shows. Absent = unchanged. */
export type TaskLineChange = {
  workspaceId: string; taskId: string; actor: ActorCtx;
  /** The new status. */
  status?: string;
  /** The time now, `null` for none: written at the start of the line's text. */
  time?: { time: string | null; until: string | null };
};
type Hook = (change: TaskLineChange) => Promise<void>;

let hook: Hook | null = null;

/** Install the line writer (modules/tasks/lines.ts, once at load). */
export function setTaskLineHook(next: Hook): void {
  hook = next;
}

/** A task's status or time changed (not from its line): put its line in step. */
export async function taskLineChanged(change: TaskLineChange): Promise<void> {
  if (hook) await hook(change);
}

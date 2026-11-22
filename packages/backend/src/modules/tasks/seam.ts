// What core calls into the tasks module for (services/taskSeam.ts), installed
// when this file loads. Every behaviour is gated on the module being on in the
// workspace: with it off a note save leaves its task lines and their tasks
// exactly as they are (the data is kept; the next save after turning it on
// brings them in step again), and no new task is made from a line.

import { getWorkspaceId } from "../../db.js";
import { moduleLeftOn } from "../../services/workspaceModules.js";
import { functionTagNames } from "../../services/functionRefs.js";
import { TASK_WORD_WHEN_TASK_IS_A_TAG } from "../../services/tasksStore.js";
import { taskLineWords } from "../../services/lineWordRules.js";
import { installTaskSeam } from "../../services/taskSeam.js";
import { syncBlockTasks } from "./blockTasks.js";
import { splitValidTaskFields } from "./fields.js";
import { deleteTaskLine, undeleteTaskLine } from "./deletion.js";
import { updateTask } from "./update.js";
import type { TaskPatch } from "./update.js";
import { TASKS_MODULE_ID, TASK_TAG_NAME } from "../../spine/taskIdentity.js";
// Installs the task → line writer into updateTask (block-nodes.md B4).
import "./lines.js";

/** Whether the tasks module is on in this workspace. */
export const tasksOn = (workspaceId: string): Promise<boolean> => moduleLeftOn(workspaceId, TASKS_MODULE_ID);

/** See TaskSeam.lineWords. The module's tag nodes stay until the last function-reference batch; until then the word
 *  is whatever the tag is called now. */
async function lineWords(workspaceId: string): Promise<string[]> {
  // The user's own `task` tag stays a tag; see tasksStore.taskLineWord.
  return taskLineWords(await functionTagNames(workspaceId, TASKS_MODULE_ID, TASK_TAG_NAME), TASK_TAG_NAME, TASK_WORD_WHEN_TASK_IS_A_TAG);
}

installTaskSeam({
  lineWords,
  linesAreTasks: tasksOn,
  async syncLines(opts) {
    if (!(await tasksOn(opts.workspaceId))) return;
    await syncBlockTasks(opts);
  },
  updateTask: (actor, id, patch) => updateTask(actor, id, patch as TaskPatch),
  async deleteTaskLine(actor, id) {
    if (!(await tasksOn(await getWorkspaceId()))) return "not_a_line";
    return deleteTaskLine(actor, id);
  },
  async undeleteTaskLine(actor, id) {
    if (!(await tasksOn(await getWorkspaceId()))) return "not_a_line";
    return undeleteTaskLine(actor, id);
  },
  splitValidFields: splitValidTaskFields,
});

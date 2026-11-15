import type { ModuleDefinition } from "../types.js";
import { getWorkspaceId } from "../../db.js";
import tasksRouter, { addTaskUnderNote } from "./routes.js";
import { startTaskScheduler } from "./scheduler.js";
import { startPushReminders } from "./pushReminders.js";
import { tasksOn } from "./seam.js";
import { K } from "../../spine/taskIdentity.js";
import { successorOfReopenedTask } from "../../services/tasksStore.js";
import { moveTaskLine } from "../../services/blockNodes.js";
import { reminderStatusOpen } from "@onden/markdown";

// Tasks (任務): the Tasks page, quick-add, reminders and the checkbox lines of
// notes that are tasks (`- [ ] … {task}`). A built-in module on in every
// workspace unless the owner turned it off (docs/architecture/tasks-module.md).
//
// A task node references the tasks function (function_refs, holder = the task
// node; spine/taskIdentity.ts), not a tag. `{task}` on a checkbox line is the
// module's own reserved word (seam.ts); it is never resolved to a tag.
//
// Off: the tasks and their tag stay as they are; the scheduler skips the
// workspace; writes under /api/tasks answer 409 `module_not_imported` while
// reads keep serving (the agenda); a note save neither makes tasks from lines
// nor changes the tasks it has (seam.ts); the frontend hides the Tasks page and
// reminders. A checkbox `- [ ]` is core Markdown and ticks either way.
//
// What stays in core, because it must work whether or not the module is on:
// the task node substrate (services/tasksStore, taskIdentity: read policy,
// space scope, sync, trash and backup recognise task nodes), the day lens
// (modules/daily) and the status → line hook (services/taskLineHook).
export const tasksModule: ModuleDefinition = {
  id: "tasks",
  routePrefixes: ["/api/tasks"],
  registerRoutes: (app) => {
    app.route("/api/tasks", tasksRouter);
    // A task added under a note lives at the note's path, outside the prefix.
    app.post("/api/nodes/:id/tasks", async (c, next) => {
      if (!(await tasksOn(await getWorkspaceId()))) return c.json({ error: "module_not_imported", module: "tasks" }, 409);
      await next();
    }, addTaskUnderNote);
  },
  // D8 time-trigger: roll unattended recurring tasks forward (break-or-make),
  // in the workspaces where the module is on.
  startBackground: () => {
    startTaskScheduler();
    // Lock-screen reminders: only when the server has VAPID keys (pushReminders.ts).
    startPushReminders();
  },
  // No module tag: a task node references the tasks function (migration 191); migration 196 removed the tag nodes.
  library: {},
  nodeHooks: {
    // A task open again (its completion or its missed roll undone, from Tasks, its line or the history): the line of its note
    // goes back to it from the next occurrence it had moved on to.
    attributeCommitted: async ({ workspaceId, nodeId, key, value }) => {
      if (key !== K.status || !(value === "waiting" || reminderStatusOpen(value))) return;
      const movedOnTo = await successorOfReopenedTask(workspaceId, nodeId);
      if (movedOnTo) await moveTaskLine(workspaceId, movedOnTo, nodeId);
    },
  },
  // Focus records (focus.ts) belong to the person who made them.
  personalTables: ["focus_sessions"],
};

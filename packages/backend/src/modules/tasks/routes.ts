import { Hono } from "hono";
import { readJsonBody, uuidParam } from "../../routes/params.js";
import { getWorkspaceId } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { taskAgenda } from "./agenda.js";
import { createTask, hostedTaskSchema, standaloneTaskSchema } from "./create.js";
import { placeTask, placeTaskSchema, unplaceTask } from "./placement.js";
import { editFocus, editFocusSchema, endFocus, endFocusSchema, focusDaySchema, focusOfDay, startFocus, startFocusSchema } from "./focus.js";
import { taskPatchSchema, updateTask, TaskUpdateRefusal } from "./update.js";
// Installs the task → line writer into updateTask (block-nodes.md B4).
import "./lines.js";

// D8 Tasks Phase 3 — the agenda is SERVER-computed (one bucket query, same
// answer on every device), statuses are rich enough to keep noise off it
// (waiting, and someday for parked ones), and recurrence is break-or-make:
// completing a recurring task mints the next occurrence as a REAL task node +
// event, in the same transaction as the completion.
//
// Storage (migration 062, 135): a task is a NODE — hidden, tagged with the
// tasks module's tag, with _task_* attributes — parented to its host note, or
// standalone (no parent, in a space of its own). The API shape here is the old
// node_tasks contract plus the newer fields; rows are synthesized from
// nodes+attrs (services/tasksStore).

// The agenda read model lives in agenda.ts, the update operation in update.ts,
// creating in create.ts and placing in placement.ts; this router parses and
// answers.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();


/** A refusal answers its status and error; anything else is the shared mapping's. */
async function refusing<T>(run: () => Promise<T>, answer: (value: T) => Response, fail: (status: 400 | 404 | 409, error: string) => Response): Promise<Response> {
  try {
    return answer(await run());
  } catch (e) {
    if (e instanceof TaskUpdateRefusal) return fail(e.status, e.error);
    throw e;
  }
}

// GET /api/tasks/agenda — the bucketed view TasksMode renders.
router.get("/agenda", async (c) => c.json(await taskAgenda(c.get("actor"), await getWorkspaceId())));

// POST /api/tasks — a standalone task (no note; the creator's personal space
// unless `space_id` names one). The client mints `id`; a replay answers the task it made.
router.post("/", async (c) => {
  const input = standaloneTaskSchema.parse(await readJsonBody(c, { optional: true }));
  return refusing(() => createTask(c.get("actor"), input), (task) => c.json(task, 201), (status, error) => c.json({ error }, status));
});

// Focus records (focus.ts): begin, end, fix, and a day's list.
router.get("/focus", async (c) => c.json(await focusOfDay(c.get("actor"), focusDaySchema.parse({ day: c.req.query("day") }))));
router.post("/focus", async (c) => {
  const input = startFocusSchema.parse(await readJsonBody(c, { optional: true }));
  return refusing(() => startFocus(c.get("actor"), input), (session) => c.json(session, 201), (status, error) => c.json({ error }, status));
});
router.post("/focus/:id/end", async (c) => {
  const input = endFocusSchema.parse(await readJsonBody(c, { optional: true }));
  return refusing(() => endFocus(c.get("actor"), uuidParam(c, "id"), input), (session) => c.json(session), (status, error) => c.json({ error }, status));
});
router.patch("/focus/:id", async (c) => {
  const input = editFocusSchema.parse(await readJsonBody(c, { optional: true }));
  return refusing(() => editFocus(c.get("actor"), uuidParam(c, "id"), input), (session) => c.json(session), (status, error) => c.json({ error }, status));
});

// PATCH /api/tasks/:id — status / when_date / evening / someday / deadline /
// recur / recur_mode / remind_at / time / until / title (update.ts).
router.patch("/:id", async (c) => {
  const id = uuidParam(c, "id");
  const input = taskPatchSchema.parse(await readJsonBody(c, { optional: true }));
  return refusing(() => updateTask(c.get("actor"), id, input), (task) => c.json(task), (status, error) => c.json({ error }, status));
});

// POST /api/tasks/:id/place — a standalone task becomes a line of a note.
router.post("/:id/place", async (c) => {
  const input = placeTaskSchema.parse(await readJsonBody(c, { optional: true }));
  return refusing(() => placeTask(c.get("actor"), uuidParam(c, "id"), input), (task) => c.json(task), (status, error) => c.json({ error }, status));
});

// POST /api/tasks/:id/unplace — the line leaves its note; the task is standalone again.
router.post("/:id/unplace", async (c) => {
  return refusing(() => unplaceTask(c.get("actor"), uuidParam(c, "id")), (task) => c.json(task), (status, error) => c.json({ error }, status));
});

/** POST /api/nodes/:id/tasks — a task added under a note (mounted by the module). */
export async function addTaskUnderNote(c: import("hono").Context<{ Variables: { actor: ActorCtx | null } }>): Promise<Response> {
  const input = hostedTaskSchema.parse(await readJsonBody(c, { optional: true }));
  return refusing(() => createTask(c.get("actor"), input, { hostId: uuidParam(c, "id") }), (task) => c.json(task, 201), (status, error) => c.json({ error }, status));
}

export default router;

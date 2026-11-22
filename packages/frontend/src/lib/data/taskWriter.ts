import { reminderAfterMove } from "@onden/markdown/contract";
import type { NodeTask } from "../api";
import { upsertTask, removeTask } from "../localDb";
import { randomUUID } from "../uuid";
import { workspaceDayStartHour } from "../localDate";
import { t } from "../i18n";
import { makeWriteLifecycle, reconcileFields } from "./writeLifecycle";
import { makeOnlineOperation } from "./onlineWrite";
import { optimisticFields } from "./optimisticFields";
import type { DataCtx } from "./types";

/** The fields of a task a write may carry, under the names the server takes
 *  (docs/architecture/tasks-module.md). `null` clears one; a cleared flag is
 *  off. `due_date` is the older name of `when_date`. */
export type TaskPatch = Partial<Pick<NodeTask, "title" | "status" | "due_date" | "when_date" | "deadline" | "recur" | "remind_at" | "time" | "until">> & {
  evening?: boolean | null;
  someday?: boolean | null;
  recur_mode?: NodeTask["recur_mode"] | null;
};

/** What to send to create a task. `when` is the day to do it. */
export type NewTaskFields = {
  when?: string | null;
  evening?: boolean;
  someday?: boolean;
  deadline?: string | null;
  recur?: string | null;
  recurMode?: "fixed" | "after";
  remindAt?: string | null;
  /** HH:MM it starts (and ends): written at the start of its line. */
  time?: string | null;
  until?: string | null;
};

/** The request fields for `fields`: only what is set, under the server's names. */
function bodyFields(fields: NewTaskFields): Record<string, unknown> {
  return {
    ...(fields.when ? { when_date: fields.when } : {}),
    ...(fields.evening ? { evening: true } : {}),
    ...(fields.someday ? { someday: true } : {}),
    ...(fields.deadline ? { deadline: fields.deadline } : {}),
    ...(fields.recur ? { recur: fields.recur } : {}),
    ...(fields.recurMode === "after" ? { recur_mode: "after" } : {}),
    ...(fields.remindAt ? { remind_at: fields.remindAt } : {}),
    ...(fields.time ? { time: fields.time } : {}),
    ...(fields.until ? { until: fields.until } : {}),
  };
}

/** The fields of a new task row, as the row holds them (both names of its day). */
function rowFields(fields: NewTaskFields): Partial<NodeTask> {
  return {
    ...(fields.when ? { when_date: fields.when, due_date: fields.when } : {}),
    ...(fields.evening ? { evening: true } : {}),
    ...(fields.someday ? { someday: true } : {}),
    ...(fields.deadline ? { deadline: fields.deadline } : {}),
    ...(fields.recur ? { recur: fields.recur } : {}),
    ...(fields.recurMode ? { recur_mode: fields.recurMode } : {}),
    ...(fields.remindAt ? { remind_at: fields.remindAt } : {}),
    ...(fields.time ? { time: fields.time } : {}),
    ...(fields.until ? { until: fields.until } : {}),
  };
}

/** A patch as the task row holds it: the day under both its column names
 *  (the mirror keeps `due_date` beside `when_date`), "later" as someday,
 *  a cleared flag as off. What the server will answer for these changes. */
export function rowChanges(changes: TaskPatch, previous?: Pick<NodeTask, "when_date" | "due_date" | "time" | "remind_at">): Partial<NodeTask> {
  const { when_date: when, status, evening, someday, recur_mode: mode, ...rest } = changes;
  const next: Partial<NodeTask> = { ...rest };
  if (mode !== undefined) next.recur_mode = mode === "after" ? "after" : "fixed";
  if (when !== undefined) { next.when_date = when; next.due_date = when; }
  if (status !== undefined) next.status = status === "later" ? "todo" : status;
  if (evening !== undefined) next.evening = evening === true;
  if (someday !== undefined || status === "later") next.someday = someday === true || status === "later";
  // A wall-clock reminder goes with its task's day and time (the server applies the same rule, @onden/markdown reminderAfterMove).
  if (previous && changes.remind_at === undefined && (when !== undefined || changes.time !== undefined)) {
    const before = { when: previous.when_date ?? previous.due_date ?? null, time: previous.time ?? null };
    const moved = reminderAfterMove(previous.remind_at ?? null, before, {
      when: when !== undefined ? when : before.when, time: changes.time !== undefined ? changes.time : before.time,
    }, workspaceDayStartHour());
    if (moved !== (previous.remind_at ?? null)) next.remind_at = moved;
  }
  return next;
}

export function makeTaskWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);
  const onlineOperation = makeOnlineOperation(ctx);

  /** Make a task, under a note (`nodeId`) or standalone (null: no note; it lives
   *  in `opts.spaceId`, default the creator's personal space). With `opts.into`
   *  (a standalone create) the server writes it into that note as a checkbox
   *  line in the same request, so it never exists outside a note. The id is
   *  minted here so an offline-made task keeps it when the queue replays. */
  async function createTask(nodeId: string | null, title: string, opts: NewTaskFields & { spaceId?: string; into?: string } = {}) {
    const id = randomUUID();
    const fields = rowFields(opts);
    const task: NodeTask = { id, node_id: nodeId ?? opts.into ?? null, title: title.trim(), status: "todo", ...fields, ...(opts.spaceId ? { space_id: opts.spaceId } : {}) };
    ctx.setData((state) => ({ ...state, tasks: [...state.tasks, task] }));
    let storedId = id;
    const result = await commit<NodeTask>(`task:${id}`, {
      method: "POST", path: nodeId ? `/api/nodes/${nodeId}/tasks` : "/api/tasks", idemKey: id,
      body: JSON.stringify({ id, title: task.title, ...bodyFields(opts), ...(nodeId === null && opts.spaceId ? { space_id: opts.spaceId } : {}), ...(nodeId === null && opts.into ? { into: { note_id: opts.into } } : {}) }),
    }, {
      mirror: async () => {
        const current = ctx.data.tasks.find((row) => row.id === storedId);
        if (current) await upsertTask(current);
        else await removeTask(storedId);
      },
      accepted: async (saved) => {
        if (saved.status !== "synced" || !saved.value?.id) return;
        const server = saved.value;
        ctx.setData((state) => ({ ...state, tasks: state.tasks.map((row) => row.id === id ? reconcileFields(row, task, server) : row) }));
        storedId = server.id;
        if (storedId !== id) await removeTask(id);
      },
      rejected: () => ctx.setData((state) => ({ ...state, tasks: state.tasks.filter((row) => row.id !== id) })),
    });
    return result;
  }

  /** A task under a note (the note's Tasks list, a line, quick capture). */
  function create(nodeId: string, title: string, opts?: NewTaskFields) {
    return createTask(nodeId, title, opts);
  }

  /** A task made without a note to hang under: in a space of its own, or —
   *  with `into` — written into that note as a line. Saved like any task,
   *  offline included. */
  function createStandaloneTask(title: string, opts: NewTaskFields & { spaceId?: string; into?: string } = {}) {
    return createTask(null, title, opts);
  }

  async function patch(id: string, changes: TaskPatch, snapshot?: NodeTask) {
    if (snapshot && !ctx.data.tasks.some((task) => task.id === id)) ctx.setData((state) => ({ ...state, tasks: [...state.tasks, snapshot] }));
    const previous = ctx.data.tasks.find((task) => task.id === id);
    const local = rowChanges(changes, previous);
    const settle = optimisticFields<Partial<NodeTask>>(`task:${id}`, previous ?? {}, local);
    const finish = (accepted: boolean, server?: NodeTask) => {
      const { expected, replacement } = settle(accepted, server);
      ctx.setData((state) => ({ ...state, tasks: state.tasks.map((task) => task.id === id ? reconcileFields<NodeTask>(task, expected, replacement) : task) }));
    };
    // Local-only stamp (never sent): the offline agenda orders its
    // completed tail by updated_at, so a task finished offline leads it like online.
    const touched = new Date().toISOString();
    ctx.setData((state) => ({ ...state, tasks: state.tasks.map((task) => task.id === id ? { ...task, ...local, updated_at: touched } : task) }));
    return commit<NodeTask>(`task:${id}`, {
      method: "PATCH", path: `/api/tasks/${id}`, body: JSON.stringify(changes),
    }, {
      mirror: async () => {
        const current = ctx.data.tasks.find((task) => task.id === id);
        if (current) await upsertTask(current);
      },
      accepted: (saved) => finish(true, saved.status === "synced" && saved.value?.id === id ? saved.value : undefined),
      rejected: () => finish(false),
      unconfirmed: () => { settle(true); },
    });
  }

  /** Take the server's answer for a task into the store and the local copy. */
  async function adopt(row: NodeTask) {
    ctx.setData((state) => ({ ...state, tasks: state.tasks.some((task) => task.id === row.id)
      ? state.tasks.map((task) => task.id === row.id ? { ...task, ...row } : task) : [...state.tasks, row] }));
    const current = ctx.data.tasks.find((task) => task.id === row.id);
    if (current) await upsertTask(current);
  }

  /** The note's own change (the line) arrives with the next sync; ask for it now. */
  async function refreshNote() {
    try { await ctx.refresh(); }
    catch { ctx.addToast(t("The change is saved. Refresh to load the latest details."), "info"); }
  }

  /** Put a standalone task into a note as a checkbox line, after the block
   *  `afterBlockRef` or at the end. The server writes the line, so this needs
   *  a connection and nothing queued; the answer is the task, now in the note.
   *  Resolves with the `^id` of the new line. */
  function placeTask(id: string, noteId: string, afterBlockRef?: string): Promise<string> {
    return onlineOperation(`task:${id}`, t("Putting a task into a note needs a connection"), async (submit) => {
      const body = JSON.stringify({ note_id: noteId, ...(afterBlockRef ? { after_block_ref: afterBlockRef } : {}) });
      const saved = await submit<NodeTask & { block_ref: string }>(`/api/tasks/${id}/place`, body);
      if (!("id" in saved)) return "";
      const { block_ref: ref, ...row } = saved;
      try { await adopt(row); } catch { ctx.addToast(t("The change is saved, but its local copy could not be updated."), "error"); }
      await refreshNote();
      return ref;
    });
  }

  /** Take a task out of its note: its line leaves the note and it is a
   *  standalone task again. Needs a connection and nothing queued. */
  function unplaceTask(id: string): Promise<void> {
    return onlineOperation(`task:${id}`, t("Taking a task out of a note needs a connection"), async (submit) => {
      const saved = await submit<NodeTask>(`/api/tasks/${id}/unplace`);
      if ("id" in saved) {
        try { await adopt(saved); } catch { ctx.addToast(t("The change is saved, but its local copy could not be updated."), "error"); }
      }
      await refreshNote();
    });
  }

  /** Delete a task: DELETE /api/nodes/:id, the one delete. A task written in a note is a line of it, and the server takes
   *  the line out of the note in the same transaction, so the note's next save cannot bring the task back. Task nodes are
   *  not in the note list, so the delete cannot go through noteWriter.remove (it would find no node and send nothing).
   *  Offline it is queued as it is; the server does the line when it is sent. Resolves null when there is no such task. */
  async function remove(id: string) {
    const previous = ctx.data.tasks.find((task) => task.id === id);
    if (!previous) return null;
    ctx.setData((state) => ({ ...state, tasks: state.tasks.filter((task) => task.id !== id) }));
    const result = await commit<{ deleted: boolean }>(`task:${id}`, { method: "DELETE", path: `/api/nodes/${id}`, body: null }, {
      destructive: true,
      mirror: () => removeTask(id),
      rejected: () => ctx.setData((state) => ({ ...state, tasks: state.tasks.some((task) => task.id === id) ? state.tasks : [...state.tasks, previous] })),
    });
    // The note's new body arrives with the next sync; ask for it now so the line is not shown (or saved back over) meanwhile.
    if (previous.node_id !== null && result.status === "synced") await refreshNote();
    return result;
  }

  return { create, createStandaloneTask, patch, remove, placeTask, unplaceTask };
}

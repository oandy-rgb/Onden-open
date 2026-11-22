// The Tasks page's task list as TaskItems (standalone tasks, checkbox
// lines) and every action a row or the settings sheet can ask for — tick,
// reopen, plan for today, drop, park, open. One place decides what a tick says and how it is undone;
// the page (TasksMode) only chooses which rows to draw (its tabs).

import { useCallback, useMemo, useState } from "react";
import { nextOccurrenceDate } from "@onden/markdown";
import { addToast, useAllNodes, useTaskRows } from "../../lib/appStore";
import { nodeActions, writeErrors, writersFor } from "../../lib/data";
import type { TaskPatch } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { revealBlockInNote } from "../../lib/noteReveal";
import { useToday } from "../../hooks/useToday";
import {
  describeDay, dropChanges, isOpen, planTodayChanges, toTaskItem, whenChanges,
  type PlannedChange, type TaskChanges, type TaskItem, type TaskRow as TaskRowData,
} from "../../lib/tasks";
import type { NoteChoice, TaskActions } from "./TaskSheet";
import { dayLabel } from "./taskLabels";
import { isNote } from "@onden/markdown/contract";

export type TaskBoardOptions = {
  online: boolean;
  /** Open a note (a task's host note, a task's own body). */
  onSelectNode: (id: string) => void;
  onRefresh: () => void;
  /** Surface a write failure (toast). */
  onError: (message: string) => void;
  /** Only the tasks of this space (null: all). */
  spaceId?: string | null;
};

export function useTaskBoard({ online, onSelectNode, onRefresh, onError, spaceId = null }: TaskBoardOptions) {
  const t = useT();
  const today = useToday();
  const rows = useTaskRows() as TaskRowData[];
  const nodes = useAllNodes();
  const writer = useMemo(() => writersFor({ notify: (message) => onError(message), online }).task, [onError, online]);

  const [sheetId, setSheetId] = useState<string | null>(null);
  // Ticked on this page: kept on screen, struck through, until the page moves on.
  const [justDone, setJustDone] = useState<ReadonlySet<string>>(new Set());

  const noteTitles = useMemo(() => new Map(nodes.map((n) => [n.id, n.title])), [nodes]);
  // A task is in its own space, else its note's (a line).
  const spaceOfTask = useMemo(() => {
    const ofNode = new Map(nodes.map((n) => [n.id, n.space_id ?? null]));
    return (task: TaskItem) => (rows.find((r) => r.id === task.id)?.space_id ?? ofNode.get(task.noteId ?? task.id) ?? null);
  }, [rows, nodes]);
  // Two sources, one list: standalone tasks and checkbox lines (both are task rows).
  const items = useMemo(() => {
    const all = rows.map((row) => toTaskItem(row, (id) => noteTitles.get(id)));
    return spaceId ? all.filter((task) => spaceOfTask(task) === spaceId) : all;
  }, [rows, noteTitles, spaceId, spaceOfTask]);
  const sheetTask = sheetId ? items.find((task) => task.id === sheetId) ?? null : null;
  const notes = useMemo<NoteChoice[]>(
    () => nodes.filter((n) => isNote(n) && n.source_type !== "system").map((n) => ({ id: n.id, title: n.title })),
    [nodes],
  );

  const write = useCallback(async (id: string, changes: TaskChanges): Promise<boolean> => {
    try {
      await writer.patch(id, changes as TaskPatch);
      onRefresh();
      return true;
    } catch (e) {
      if (!writeErrors.wasReported(e)) onError(writeErrors.message(e));
      return false;
    }
  }, [writer, onRefresh, onError]);

  // Place / take out need a connection; a refusal says why, once.
  const settle = useCallback(async (op: Promise<unknown>) => {
    try { await op; onRefresh(); }
    catch (e) { if (!writeErrors.wasReported(e)) onError(writeErrors.message(e)); }
  }, [onRefresh, onError]);

  const keepDone = useCallback((id: string, keep: boolean) => setJustDone((prev) => {
    const next = new Set(prev);
    if (keep) next.add(id); else next.delete(id);
    return next;
  }), []);
  const clearJustDone = useCallback(() => setJustDone(new Set()), []);

  const reopen = useCallback(async (task: TaskItem) => {
    keepDone(task.id, false);
    await write(task.id, { status: "todo" });
  }, [write, keepDone]);

  const complete = useCallback(async (task: TaskItem) => {
    keepDone(task.id, true);
    if (!(await write(task.id, { status: "done" }))) { keepDone(task.id, false); return; }
    // A hint for the notice; the server mints the real one by the same rule.
    const next = nextOccurrenceDate({ recur: task.recur, recurMode: task.recurMode, when: task.whenDate }, today);
    const message = next
      ? t("Done “{title}”. Next: {date}", { title: task.title, date: dayLabel(describeDay(next, today), t) })
      : task.noteTitle
        ? t("Done “{title}”; the line in “{note}” is ticked too", { title: task.title, note: task.noteTitle })
        : t("Done “{title}”", { title: task.title });
    addToast(message, "success", { label: t("Undo"), onClick: () => { void reopen(task); } });
  }, [write, today, t, reopen, keepDone]);

  // Several writes in a row: stops at the first refusal (already told once), and returns the ones that landed.
  const writePlanned = useCallback(async (planned: readonly PlannedChange[]): Promise<PlannedChange[]> => {
    const applied: PlannedChange[] = [];
    for (const step of planned) {
      if (!(await write(step.id, step.changes))) break;
      applied.push(step);
    }
    return applied;
  }, [write]);
  const undoPlanned = useCallback(async (applied: readonly PlannedChange[]) => {
    for (const step of applied) await write(step.id, step.undo);
  }, [write]);
  const toastUndoable = (message: string, applied: readonly PlannedChange[]) => {
    if (applied.length === 0) return;
    addToast(message, "success", { label: t("Undo"), onClick: () => { void undoPlanned(applied); } });
  };

  const planToday = async (task: TaskItem) => {
    const applied = await writePlanned([planTodayChanges(task, today)]);
    toastUndoable(t("Planned “{title}” for today", { title: task.title }), applied);
  };
  const drop = async (task: TaskItem) => {
    const applied = await writePlanned([dropChanges(task)]);
    toastUndoable(t("Dropped “{title}”", { title: task.title }), applied);
  };
  const parkSomeday = (task: TaskItem) => { void write(task.id, whenChanges({ kind: "someday" }, today)); };

  const actions: TaskActions = {
    change: (task, changes) => { void write(task.id, changes); },
    complete: (task) => { void complete(task); },
    openNote: (noteId, blockRef) => { if (blockRef) revealBlockInNote(noteId, blockRef); onSelectNode(noteId); },
    openBody: onSelectNode,
    remove: (task) => { void nodeActions.delete(task.id, task.title); },
    drop: (task) => { void drop(task); },
    place: (task, noteId) => { void settle(writer.placeTask(task.id, noteId)); },
    unplace: (task) => { void settle(writer.unplaceTask(task.id)); },
  };

  const toggle = (task: TaskItem) => { void (isOpen(task.status) && !justDone.has(task.id) ? complete(task) : reopen(task)); };

  return {
    today, items, justDone, clearJustDone, sheetTask, setSheetId, notes, actions, toggle, planToday, parkSomeday, spaceOfTask,
  };
}

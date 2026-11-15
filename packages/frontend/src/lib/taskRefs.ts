// Tasks as link and embed targets (T6). A task is a hidden node the note list
// never holds (it lives in `data.tasks`), so `[[` completion, `[[…]]` links
// and `![[…]]` embeds look it up here instead of in `nodes`:
//
//   [[onden://node/<id>|Buy milk]]   a link that names the task by id
//   ![[onden://node/<id>]]           the task as a live checkbox row
//   ![[Buy milk]]                    the same, by title, when no note has it
//
// The id spelling is @onden/markdown nodeRef; two tasks with one title are
// never mixed up. The published site registers nothing, so none of this
// resolves there (its tasks are inert text, redaction.ts).
//
// This file is pure and loaded by the published site's bundle: the app
// registers where the rows come from (lib/taskRefs.app.ts) and labels live in
// lib/taskChips.ts.

import { useSyncExternalStore } from "react";
import { checklistLine, nodeRefId } from "@onden/markdown";
import type { WikilinkNode } from "./wikilinks";
import { normalizeText } from "@onden/markdown";

/** A task row as the app holds it (api NodeTask) plus the fields the task
 *  rework adds. Absent fields read as "not set". */
export type TaskRefRow = {
  id: string;
  /** The note the task is a line of; null/absent: a standalone task. */
  node_id?: string | null;
  title: string;
  status: string;
  space_id?: string | null;
  when_date?: string | null;
  /** The pre-rework spelling of `when_date`. */
  due_date?: string | null;
  deadline?: string | null;
  evening?: boolean | null;
  someday?: boolean | null;
  recur?: string | null;
};

export type TaskFacts = {
  status: string;
  done: boolean;
  when: string | null;
  evening: boolean;
  someday: boolean;
  deadline: string | null;
  recur: string | null;
  hostId: string | null;
  hostTitle: string | null;
  /** This reader may complete it (they may write in its space). */
  writable: boolean;
};

/** A task in the shape links resolve: a node-like row (`node_type: "task"`) with its facts. */
export type TaskRef = WikilinkNode & { node_type: "task"; task: TaskFacts };

export function isTaskRef(node: WikilinkNode | null | undefined): node is TaskRef {
  return node?.node_type === "task" && "task" in node;
}

export type TaskRefHost = { id: string; title: string; space_id?: string | null };

/** The link rows for `tasks`. `hosts` are the notes the reader holds; a task
 *  whose note is not among them is shown without a note name. `canEdit` says
 *  whether the reader may write in a space. */
export function taskRefsFrom(
  tasks: readonly TaskRefRow[], hosts: readonly TaskRefHost[], canEdit: (spaceId: string | null) => boolean,
): TaskRef[] {
  const host = new Map(hosts.map((h) => [h.id, h]));
  return tasks.map((row) => {
    const note = row.node_id ? host.get(row.node_id) : undefined;
    const space = note ? note.space_id ?? null : row.space_id ?? null;
    return {
      id: row.id,
      title: row.title,
      slug: `task-${row.id}`,
      space_id: space,
      node_type: "task" as const,
      task: {
        status: row.status,
        done: row.status === "done",
        when: row.when_date ?? row.due_date ?? null,
        evening: !!row.evening,
        someday: !!row.someday,
        deadline: row.deadline ?? null,
        recur: row.recur ?? null,
        hostId: row.node_id ?? null,
        hostTitle: note?.title ?? null,
        writable: canEdit(space),
      },
    };
  });
}

// ── Where the app's tasks come from ────────────────────────────────────────

export type TaskRefSource = { tasks(): readonly TaskRef[]; subscribe(listener: () => void): () => void };

let source: TaskRefSource | null = null;
const NONE: readonly TaskRef[] = [];

/** The app registers its task rows once (lib/taskRefs.app.ts); null unregisters (tests). */
export function registerTaskRefs(next: TaskRefSource | null): void {
  source = next;
}

/** The tasks a reader may link to now. Empty on the published site. */
export function currentTaskRefs(): readonly TaskRef[] {
  return source?.tasks() ?? NONE;
}

export function useTaskRefs(): readonly TaskRef[] {
  return useSyncExternalStore((listener) => source?.subscribe(listener) ?? (() => {}), currentTaskRefs, () => NONE);
}

/** The task a link or embed target names: by id (`onden://node/<id>`), else by
 *  title (case-insensitive, as links read titles). null when it names none. */
export function resolveTaskRef(target: string, tasks: readonly TaskRef[] = currentTaskRefs()): TaskRef | null {
  const id = nodeRefId(target);
  if (id) return tasks.find((task) => task.id.toLowerCase() === id) ?? null;
  const wanted = normalizeText(target.trim()).toLowerCase();
  if (!wanted) return null;
  return tasks.find((task) => normalizeText(task.title.trim()).toLowerCase() === wanted) ?? null;
}

/** The task with this id, or null. */
export function taskRefById(id: string, tasks: readonly TaskRef[] = currentTaskRefs()): TaskRef | null {
  return tasks.find((task) => task.id === id) ?? null;
}

/** Where a task's line starts in its note's Markdown: the checklist line whose
 *  text is the task's title (the line is the task's text, block-nodes.md B4).
 *  null when the note is not held in full or no line reads so. */
export function taskLineRange(markdown: string, title: string): { start: number; end: number } | null {
  if (!markdown || !title.trim()) return null;
  let start = 0;
  for (const line of markdown.split("\n")) {
    const end = start + line.length;
    if (checklistLine(line) && line.includes(title.trim())) return { start, end };
    start = end + 1;
  }
  return null;
}

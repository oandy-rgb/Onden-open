// The standalone tasks of a Markdown export (services/exportZip.ts writeVault):
// `任務/任務.md` (English: `Tasks/Tasks.md`), the list services/taskListFile.ts
// describes, plus `任務/<標題>.md` for each task that has body text, linked from
// its line. Nothing is written when the actor reads no standalone task.

import { localDayId } from "../localDay.js";
import type { ActorCtx } from "../types.js";
import type { ArchiveSink } from "./archiveStream.js";
import { vaultName } from "./vaultPath.js";
import { readableStandaloneTasks } from "./standaloneTasks.js";
import { DONE_AT_KEY, STATUS_KEY, TASK_FOLDER, renderTaskList, type TaskListItem, type TaskListLang } from "./taskListFile.js";

/** A file name for a task's note: the one rule every note's file name follows (vaultName: unsafe
 *  characters, 200 bytes, Windows reserved names). */
function noteStem(title: string): string {
  return vaultName({ id: "task", title, slug: null });
}

/** Write the task list and the task notes into `out`; returns how many
 *  tasks were written. `taken` holds the archive's other paths (lowercase,
 *  with `.md`), which a task note never reuses; `noteFile` turns a task's
 *  stored body into the text of its file (links, media), at depth one. */
export async function writeStandaloneTasks(out: ArchiveSink, options: {
  actor: ActorCtx | null;
  workspaceId: string;
  lang: TaskListLang;
  taken: ReadonlySet<string>;
  noteFile(markdown: string): Promise<string>;
}): Promise<number> {
  const { lang } = options;
  const tasks = await readableStandaloneTasks(options.actor, options.workspaceId);
  if (tasks.length === 0) return 0;
  const folder = TASK_FOLDER[lang];
  // 任務/任務.md, unless a note of that name is a child of a note called 任務:
  // the import finds the list by what it says, so any free name will do.
  let listPath = `${folder}/${folder}.md`;
  for (let n = 2; options.taken.has(listPath.toLowerCase()); n++) listPath = `${folder}/${folder}-onden-${n}.md`;
  const taken = new Set([...options.taken, listPath.toLowerCase()]);
  const items: TaskListItem[] = [];
  for (const task of tasks) {
    let bodyLink: string | null = null;
    if (task.markdown.trim() !== "") {
      const own = noteStem(task.title);
      let stem = own;
      for (let k = 6; taken.has(`${folder}/${stem}.md`.toLowerCase()); k++) stem = k > task.id.length ? `${own}-${task.id}-${k}` : `${own}-${task.id.slice(0, k)}`;
      taken.add(`${folder}/${stem}.md`.toLowerCase());
      bodyLink = `${folder}/${stem}`;
      await out.addText(`${bodyLink}.md`, await options.noteFile(task.markdown));
    }
    const done = task.fields[STATUS_KEY] === "done";
    // ✅ is the day it was completed; a task done before completion times were kept has only its last change.
    const finished = Date.parse(task.fields[DONE_AT_KEY] ?? "");
    items.push({ id: task.id, title: task.title, fields: task.fields, bodyLink, doneOn: done ? localDayId(new Date(Number.isNaN(finished) ? task.updated_at : finished)) : null });
  }
  await out.addText(listPath, renderTaskList(items, { lang, today: localDayId(), exportedAt: new Date().toISOString() }));
  return tasks.length;
}

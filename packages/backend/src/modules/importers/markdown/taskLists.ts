// The Markdown import's half of the standalone task list (services/
// taskListFile.ts, written by services/exportTasks.ts): a file an Onden export
// marked as a task list becomes standalone tasks again — not a note called
// "任務" full of checkboxes — and the note files its lines link to become the
// tasks' bodies instead of notes of their own. Any other file, Obsidian Tasks
// symbols and all, is a note as ever (importMarkdownNote).

import { posix } from "node:path";
import { clampNoteTitle, noteSizeProblem, normalizeText } from "@onden/markdown";
import { AuthorityError } from "../../../spine/authority.js";
import type { ActorCtx } from "../../../types.js";
import { importSourceMeta } from "../shared/identity.js";
import { NoteCreateError } from "../../../services/noteCreate.js";
import { ScopeError } from "../../../spine/toolScope.js";
import { createStandaloneTask, readableStandaloneTaskIds } from "../../../services/standaloneTasks.js";
import { taskSeam } from "../../../services/taskSeam.js";
import { DONE_AT_KEY, STATUS_KEY, isTaskList, parseTaskList, refMatchesId } from "../../../services/taskListFile.js";
import type { ImportConflictReason } from "./note.js";
import type { ImportSource } from "@onden/contract";

type MarkdownFile = { path: string; content: string };

export type TaskListImport = {
  /** Paths of the list files and the task note files they linked to: not notes. */
  consumed: Set<string>;
  imported: number;
  /** Lines whose `^t-…` names a task already here (an update import skips them). */
  unchanged: number;
  conflicts: Array<{ path: string; reason: ImportConflictReason }>;
  titlesTruncated: Array<{ path: string }>;
  /** Tasks imported without some fields that failed the task rules (a repeat Onden cannot run). */
  fieldsDropped: Array<{ path: string; fields: string[] }>;
};

/** The task note file a line's `[[link]]` names, among `files`: the link as a
 *  path from the vault root, or beside the list; else a unique file of that
 *  name in the list's folder. */
function linkedFile(link: string, listPath: string, byLowerPath: ReadonlyMap<string, MarkdownFile>): MarkdownFile | null {
  const target = link.replace(/\.md$/i, "");
  const dir = posix.dirname(listPath);
  for (const candidate of [`${target}.md`, posix.join(dir, `${target}.md`)]) {
    const found = byLowerPath.get(candidate.toLowerCase());
    if (found) return found;
  }
  const inFolder = [...byLowerPath.values()].filter((f) => posix.dirname(f.path) === dir && posix.basename(f.path, ".md").toLowerCase() === posix.basename(target).toLowerCase());
  return inFolder.length === 1 ? inFolder[0]! : null;
}

/** Import every task list among `files`. `rewrite` is the folder import's
 *  media pass over a note's text (its pictures come along). With `reuse`
 *  (an update import), a line whose reference names a task the actor already
 *  has is left as it is. */
export async function importTaskLists(options: {
  actor: ActorCtx; workspaceId: string; source: ImportSource; reuse: boolean;
  files: readonly MarkdownFile[];
  rewrite(content: string, path: string): string;
}): Promise<TaskListImport> {
  const { actor, workspaceId, source, reuse } = options;
  const result: TaskListImport = { consumed: new Set(), imported: 0, unchanged: 0, conflicts: [], titlesTruncated: [], fieldsDropped: [] };
  const lists = options.files.filter((f) => isTaskList(f.content));
  if (lists.length === 0) return result;
  const byLowerPath = new Map(options.files.filter((f) => !isTaskList(f.content)).map((f) => [f.path.toLowerCase(), f]));
  const existing = reuse ? await readableStandaloneTaskIds(actor, workspaceId) : [];
  const seenRefs = new Set<string>();

  for (const list of lists) {
    result.consumed.add(list.path);
    for (const line of parseTaskList(list.content)) {
      const noteFile = line.link ? linkedFile(line.link, list.path, byLowerPath) : null;
      if (noteFile) result.consumed.add(noteFile.path);
      if (line.ref && reuse) {
        // The same reference twice in one file is one task.
        if (seenRefs.has(line.ref) || existing.some((id) => refMatchesId(line.ref!, id))) { seenRefs.add(line.ref); result.unchanged++; continue; }
        seenRefs.add(line.ref);
      }
      const fullTitle = normalizeText(noteFile ? line.title : line.titleWithLink);
      const markdown = noteFile ? options.rewrite(noteFile.content, noteFile.path) : "";
      const problem = noteSizeProblem({ markdown, title: fullTitle });
      if (problem) { result.conflicts.push({ path: list.path, reason: problem === "too_large" ? "too_large" : "invalid_text" }); continue; }
      const title = clampNoteTitle(fullTitle);
      if (title !== fullTitle) result.titlesTruncated.push({ path: list.path });
      // A field the task routes would refuse is left out, not stored: the
      // scheduler would fail on it every tick. The task itself still comes in.
      const { valid: fields, invalid } = taskSeam()?.splitValidFields(line.fields) ?? { valid: line.fields, invalid: [] };
      // Done on import without a ✅ day: done now, as far as Onden knows.
      if (fields[STATUS_KEY] === "done" && !fields[DONE_AT_KEY]) fields[DONE_AT_KEY] = new Date().toISOString();
      if (invalid.length) result.fieldsDropped.push({ path: list.path, fields: invalid.map((key) => key.replace(/^_task_/, "")) });
      try {
        await createStandaloneTask({
          actor, workspaceId, title, markdown, fields,
          uiContext: "import.obsidian.tasks",
          payload: { import_path: list.path },
          txMeta: importSourceMeta(source),
        });
        result.imported++;
      } catch (error) {
        if (error instanceof AuthorityError || error instanceof ScopeError || error instanceof NoteCreateError) {
          result.conflicts.push({ path: list.path, reason: "unavailable" });
        } else throw error;
      }
    }
  }
  return result;
}

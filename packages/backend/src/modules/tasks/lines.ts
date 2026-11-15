// A task's status and time → its line (block-nodes.md B4). Completing a task in
// Tasks ticks `- [ ] text {task}` in its note; reopening it unticks it; giving
// it a time writes `15:00–16:00` at the start of the text. The
// note is saved like any edit (updateNode: events, versions, backup, block
// nodes), against the body it read, so an edit made meanwhile merges rather
// than being overwritten. Cancelling leaves the box as it is. The other way
// (a box ticked in the note) is modules/tasks/blockTasks.ts.
//
// Installed into updateTask through services/taskLineHook.ts at load: this
// file sits above the note save, which updateTask must not import.

import { taskBoxEdit, withLineTime } from "@onden/markdown";
import { parseNoteBlocks } from "../../services/blockAnchors/index.js";
import { q } from "../../db.js";
import { setTaskLineHook, type TaskLineChange } from "../../services/taskLineHook.js";
import { updateNode } from "../../services/nodeUpdate.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

/** Bring task `taskId`'s line in step: the box ticked to match `status`, the
 *  time at the start of its text to match `time`. Cancelling leaves the box. */
export async function syncTaskLine({ workspaceId, taskId, status, time, actor }: TaskLineChange): Promise<void> {
  const line = (await q<{ note_id: string; block_ref: string; markdown: string }>(
    `SELECT b.note_id, b.block_ref, n.markdown FROM block_nodes b JOIN content_nodes n ON n.id = b.note_id
      WHERE b.workspace_id = $1 AND b.task_id = $2 AND b.hidden_at IS NULL AND ${liveNodeSql("n")}
      FOR UPDATE OF n`, [workspaceId, taskId],
  )).rows[0];
  if (!line) return;
  const block = (await parseNoteBlocks(workspaceId, line.note_id, line.markdown)).find((b) => b.ref === line.block_ref);
  if (!block) return;
  // A `{task}` line that never got a box (tagged before the box came with the tag, or written by AI / an import)
  // gets one now, in this same save, unless the change is only a cancel (that leaves the line as it is).
  let markdown = line.markdown;
  let box = block.checkbox;
  const changesLine = !!time || (status !== undefined && status !== "cancelled");
  if (!box && changesLine) {
    const edit = taskBoxEdit(markdown, block.start);
    if (edit) {
      markdown = markdown.slice(0, edit.at) + edit.insert + markdown.slice(edit.at);
      box = { checked: false, at: edit.at + edit.insert.indexOf("[") + 1 };
    }
  }
  if (!box) return;
  // Edits are made back to front so the earlier offsets stay true.
  if (time) {
    const from = box.at + 2;
    const nl = markdown.indexOf("\n", from);
    const end = nl === -1 ? markdown.length : nl;
    const textFrom = from + /^[ \t]*/.exec(markdown.slice(from, end))![0].length;
    markdown = markdown.slice(0, textFrom) + withLineTime(markdown.slice(textFrom, end), time.time, time.until) + markdown.slice(end);
  }
  if (status !== undefined && status !== "cancelled" && box.checked !== (status === "done")) {
    markdown = markdown.slice(0, box.at) + (status === "done" ? "x" : " ") + markdown.slice(box.at + 1);
  }
  if (markdown === line.markdown) return;
  await updateNode(workspaceId, line.note_id, { markdown }, {
    actor, baseMarkdown: line.markdown,
    event: { uiContext: "task.status.line", cascadeLabel: "task.line.cascade", backupPrefix: "TASK_LINE" },
  });
}

setTaskLineHook(syncTaskLine);

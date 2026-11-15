// Putting a standalone task into a note, and taking it out again.
//
//   place   (POST /api/tasks/:id/place)    the task becomes a checkbox line of
//           the note — `- [ ] title {task}` after a block of the note, or at
//           its end — and the task node moves under the note, linked to that
//           line exactly as a task written in the note is (blockTasks.ts). A
//           task with a time has it at the start of the line's text.
//           POST /api/tasks does this as it creates (`into`, create.ts).
//   unplace (POST /api/tasks/:id/unplace)  the line is taken out of the note
//           and the task is standalone again, keeping its fields and body.
//
// One event transaction each: the task's move, the note's edit (its normal
// save: events, versions, block nodes) and the link commit or roll back
// together, under the current actor's rights on both the task and the note.
// A task takes the note's space; when that is another space the task is moved
// there first (spaces.moveToSpace, which has its own rules for who may).

import { z } from "zod";
import { anchoredBlocks, withLineTime, BLOCK_ID } from "@onden/markdown";
import { freeAnchorId, noteAnchorRanges, parseNoteBlocks, retireAnchor } from "../../services/blockAnchors/index.js";
import { q, getWorkspaceId } from "../../db.js";
import { requireActor } from "../../spine/mutate.js";
import { assertAuthority } from "../../spine/authority.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { canReadNode } from "../../services/readPolicy.js";
import { canPlaceUnder } from "../../services/nodePlacement.js";
import { updateNode } from "../../services/nodeUpdate.js";
import { moveToSpace } from "../../services/spaces.js";
import { taskLineWord, taskRowById, type TaskRow } from "../../services/tasksStore.js";
import type { ActorCtx } from "../../types.js";
import { adoptTaskForLine } from "./blockTasks.js";
import { TaskUpdateRefusal } from "./update.js";
import { liveNodeSql } from "../../spine/nodeSql.js";
import { isNote } from "@onden/markdown/contract";

export const placeTaskSchema = z.object({
  note_id: z.string().uuid(),
  /** Insert after the block of the note with this anchor id; absent = at the end. */
  after_block_ref: z.string().regex(BLOCK_ID).optional(),
});
export type PlaceTaskInput = z.infer<typeof placeTaskSchema>;

/** Where a new line goes to follow the block of anchor `ref`: the end of its scope, and for a list item the indent
 *  it is written at. A list item ends with its nested items, anything else with its own text. */
function anchorAfter(body: string, ref: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }>): { end: number; indent: string; listItem: boolean } | null {
  const block = anchoredBlocks(body, anchors).find((b) => b.id === ref);
  if (!block) return null;
  const lineStart = body.lastIndexOf("\n", block.start - 1) + 1;
  let end = block.end;
  while (end > block.start && /\s/.test(body[end - 1]!)) end--;
  return { end, indent: /^[ \t]*/.exec(body.slice(lineStart, block.start))?.[0] ?? "", listItem: block.kind === "listItem" };
}

/** The line text a task is written as: one line, whatever its title holds. */
const lineTitle = (title: string): string => title.replace(/\s+/g, " ").trim();

type TaskNode = { parent_id: string | null; space_id: string | null; title: string; status: string; time: string | null; until: string | null };

async function lockTask(workspaceId: string, actor: ActorCtx, id: string): Promise<TaskNode & { row: TaskRow }> {
  const row = await taskRowById(workspaceId, id);
  if (!row || !(await canReadNode(actor, id))) throw new TaskUpdateRefusal(404, "task not found");
  await q(`SELECT 1 FROM content_nodes WHERE id = $1 FOR UPDATE`, [id]);
  return { row, parent_id: row.node_id, space_id: row.space_id, title: row.title, status: row.status, time: row.time, until: row.until };
}

/** Put standalone task `id` into note `input.note_id`. Returns the task row
 *  (now with `node_id`) and the anchor id of the line made. Refusals: 404 no such
 *  task / note (or unreadable), 409 `already_placed` (it is in a note),
 *  409 `not_a_note`, 404 `block_not_found`; the spine's 403 when the actor may
 *  not write the task or the note. */
export async function placeTask(authenticated: ActorCtx | null, id: string, input: PlaceTaskInput): Promise<TaskRow & { block_ref: string }> {
  const workspaceId = await getWorkspaceId();
  const placed = await withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    const task = await lockTask(workspaceId, actor, id);
    // Who may is answered before what state it is in: a reader who may not
    // write learns nothing about whether the task is in a note.
    await assertAuthority(actor, { kind: "node", nodeId: id, op: "write_node" });
    if (task.parent_id !== null) throw new TaskUpdateRefusal(409, "already_placed");
    if (!(await canPlaceUnder(actor, workspaceId, input.note_id))) throw new TaskUpdateRefusal(404, "note not found");
    const note = (await q<{ node_type: string; markdown: string | null; space_id: string | null }>(
      `SELECT node_type, markdown, space_id::text FROM content_nodes WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [input.note_id, workspaceId])).rows[0]!;
    if (!isNote(note)) throw new TaskUpdateRefusal(409, "not_a_note");
    const body = note.markdown ?? "";

    // Where the line goes: after the block named, else at the end of the note.
    const ref = await freeAnchorId(workspaceId);
    const anchor = input.after_block_ref === undefined ? null : anchorAfter(body, input.after_block_ref, await noteAnchorRanges(workspaceId, input.note_id));
    if (input.after_block_ref !== undefined && !anchor) throw new TaskUpdateRefusal(404, "block_not_found");
    const box = task.status === "done" ? "x" : " ";
    const lineText = `- [${box}] ${withLineTime(lineTitle(task.title), task.time, task.until)} {${await taskLineWord(workspaceId)}}`;
    // The line's block gets the anchor `ref` as the note is saved (adoptAnchors): the task is adopted for it by that id.
    const head = anchor
      ? `${body.slice(0, anchor.end)}${anchor.listItem ? "\n" : "\n\n"}${anchor.listItem ? anchor.indent : ""}`
      : `${body}${body === "" || body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n"}`;
    const markdown = anchor ? `${head}${lineText}${body.slice(anchor.end)}` : `${head}${lineText}\n`;

    // The task goes where the note is: its space, then under the note.
    if (task.space_id !== note.space_id && note.space_id) {
      await moveToSpace(actor, workspaceId, id, note.space_id, null);
    }
    await updateNode(workspaceId, id, { parent_id: input.note_id }, { actor });
    // The note's save makes the line's block node; the task is adopted for it
    // instead of a new task being made from the line.
    const release = adoptTaskForLine(input.note_id, ref, id);
    try {
      await updateNode(workspaceId, input.note_id, { markdown }, {
        actor, baseMarkdown: body, adoptAnchors: [{ anchorId: ref, text: lineText, at: head.length, kind: "new" }],
        event: { uiContext: "task.place", cascadeLabel: "task.place.cascade", backupPrefix: "TASK_PLACE" },
      });
    } finally {
      release();
    }
    return ref;
  });
  return { ...(await taskRowById(workspaceId, id))!, block_ref: placed };
}

/** Take task `id` out of its note: its line is removed from the note and it
 *  is standalone again, in the space it is in. A task that was never a line
 *  (added under the note) only moves. Refusals: 404 no such task, 409
 *  `not_placed` (it is already standalone). */
export async function unplaceTask(authenticated: ActorCtx | null, id: string): Promise<TaskRow> {
  const workspaceId = await getWorkspaceId();
  await withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    const task = await lockTask(workspaceId, actor, id);
    await assertAuthority(actor, { kind: "node", nodeId: id, op: "write_node" });
    if (task.parent_id === null) throw new TaskUpdateRefusal(409, "not_placed");
    const line = (await q<{ note_id: string; block_ref: string; markdown: string | null }>(
      `SELECT b.note_id, b.block_ref, n.markdown FROM block_nodes b JOIN content_nodes n ON n.id = b.note_id
        WHERE b.workspace_id = $1 AND b.task_id = $2 AND b.hidden_at IS NULL AND ${liveNodeSql("n")}
        FOR UPDATE OF n`, [workspaceId, id])).rows[0];
    if (line) {
      if (!(await canPlaceUnder(actor, workspaceId, line.note_id))) throw new TaskUpdateRefusal(404, "note not found");
      const body = line.markdown ?? "";
      const block = (await parseNoteBlocks(workspaceId, line.note_id, body)).find((b) => b.ref === line.block_ref);
      // Let go of the link first: a line that goes while its task is still
      // linked would send the task to the trash with it (blockTasks.ts).
      await q(`UPDATE block_nodes SET task_id = NULL WHERE workspace_id = $1 AND task_id = $2`, [workspaceId, id]);
      if (block) {
        // Only the task's own line goes; items nested under it stay in the note.
        const from = body.lastIndexOf("\n", block.start - 1) + 1;
        const nl = body.indexOf("\n", block.start);
        const to = nl === -1 ? body.length : nl + 1;
        // The blank line placing a task after a paragraph (or at the end) added goes with it.
        const before = body.slice(0, from);
        let after = body.slice(to);
        if (before.endsWith("\n\n") && after.startsWith("\n")) after = after.slice(1);
        const markdown = after === "" && before.endsWith("\n\n") ? before.slice(0, -1) : before + after;
        await updateNode(workspaceId, line.note_id, { markdown }, {
          actor, baseMarkdown: body,
          event: { uiContext: "task.unplace", cascadeLabel: "task.unplace.cascade", backupPrefix: "TASK_UNPLACE" },
        });
        await retireAnchor(workspaceId, line.note_id, line.block_ref);
      }
    }
    await updateNode(workspaceId, id, { parent_id: null }, { actor });
  });
  return (await taskRowById(workspaceId, id))!;
}

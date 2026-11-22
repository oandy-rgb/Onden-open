// Deleting a task that is a line of a note, and undoing it.
//
// A task written in a note (`- [ ] … {task}`) is two things that stay in step: the task node and its line (blockTasks.ts).
// Deleting only the node used to leave the line, and the note's next save put the task back ("putting it back restores
// it"). So deleting such a task takes the line out as well, in ONE event transaction: the task goes to the trash
// (trashNode, as every delete) and the note is saved without the line (the note's normal save: events, versions, block
// nodes, anchors — placement.ts `takeLineOut`, the same removal as taking the task out of its note). Items nested under
// the line stay in the note, as they do there.
//
// The link between line and task is cut first, as in unplace, so the note's save does not trash the task and the task that
// comes back later (History, or the undo below) is an ordinary task of the note, not one a later save would trash again
// for having no line. The task is trashed after the note is saved, so its delete event can say where the line was.
//
// The delete event records where the line was (`line_note_id`, the block it followed, or "at the start"), so undoing the
// delete (POST /api/nodes/:id/undelete) writes the line back at the same place and the same task is its line again, with
// every field, and under the line's old anchor id (links to the line work again). The event also records the blank lines around the line
// and the first item that was nested under it and stayed in the note, so the text comes back byte for byte (the line goes back before that
// item). If the block it followed is gone, the line goes to the end of the note. A restore from History's event list
// brings the task back without the line.
//
// Called by the nodes route through services/taskSeam.ts; a task that is not a line is deleted by trashNode as before.

import { getWorkspaceId } from "../../db.js";
import { requireActor } from "../../spine/mutate.js";
import { assertAuthority } from "../../spine/authority.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { canPlaceUnder } from "../../services/nodePlacement.js";
import { deleteEventMeta, trashNode, undeleteNode } from "../../services/nodeTrash.js";
import { ensureBlockAnchor, parseNoteBlocks } from "../../services/blockAnchors/index.js";
import { taskRowById } from "../../services/tasksStore.js";
import type { ActorCtx } from "../../types.js";
import type { TaskLineOutcome } from "../../services/taskSeam.js";
import { blankAround, firstNestedAfter, lineOfTask, neighbourBefore, takeLineOut, writeTaskLine, type LinePlace } from "./placement.js";
import { TaskUpdateRefusal } from "./update.js";
import { NodeTrashError } from "../../services/nodeTrash.js";

/** The `ui_context` of the delete event of a task that was a line. */
const TASK_DELETE_CONTEXT = "task.delete";

/** Where the line was, as the delete event records it: the note, its anchor, its own indent, and the previous line of the same
 *  level (`line_after_ref`) or else what it sat first under (`line_under_ref`: the parent item or the heading), or the start. */
type LineMeta = {
  line_note_id: string; line_ref: string; line_indent: string; line_blank_above: number; line_blank_below: number;
  line_after_ref: string | null; line_under_ref: string | null; line_at_start: boolean;
  /** The first item that was nested under the line and stayed in the note: the line goes back right before it. */
  line_before_ref: string | null;
};

/** Delete task `id`. Returns "not_a_line", having done nothing, when it is not a line of a live note: the caller deletes it as any
 *  node. Refusals: the delete's own (404 not found, the spine's 403), 404 when the note cannot be written by the actor, and 409 `task_line_not_found` when the line cannot be found in the note's text (nothing is changed). */
export async function deleteTaskLine(authenticated: ActorCtx | null, id: string): Promise<TaskLineOutcome> {
  const workspaceId = await getWorkspaceId();
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    const line = await lineOfTask(workspaceId, id);
    if (!line) return "not_a_line";
    // Who may is answered before anything is read or changed.
    await assertAuthority(actor, { kind: "node", nodeId: id, op: "delete_node" });
    // Deleting only the node would leave the line for the note's next save to bring the task back (and cutting the link
    // instead would make that save mint a new task from it): the delete is refused whole.
    if (!(await canPlaceUnder(actor, workspaceId, line.note_id))) throw new NodeTrashError(404, "note not found");
    const body = line.markdown ?? "";
    const block = (await parseNoteBlocks(workspaceId, line.note_id, body)).find((b) => b.ref === line.block_ref);
    if (!block) throw new NodeTrashError(409, "task line not found in its note", "task_line_not_found");

    const without = await takeLineOut({
      workspaceId, actor, noteId: line.note_id, taskId: id, ref: line.block_ref, body, blockStart: block.start,
      event: { uiContext: TASK_DELETE_CONTEXT, cascadeLabel: "task.delete.cascade", backupPrefix: "TASK_DELETE" },
    });
    // Where the line was, so undo can write it back, anchored on the body as it is now (an anchor made before the removal
    // would span the line's own nested items and lose its place with them).
    const lineStart = body.lastIndexOf("\n", block.start - 1) + 1;
    const indent = /^[ \t]*/.exec(body.slice(lineStart))![0];
    const { above, below } = blankAround(body, lineStart);
    const blank = { line_blank_above: above, line_blank_below: below };
    const near = neighbourBefore(without, lineStart, indent.length);
    const nearRef = near ? await ensureBlockAnchor(workspaceId, line.note_id, without, near.at, { actor }) : null;
    const child = firstNestedAfter(without, lineStart, indent.length);
    const childRef = child === null ? null : await ensureBlockAnchor(workspaceId, line.note_id, without, child, { actor });
    const meta: LineMeta = {
      line_before_ref: childRef,
      line_note_id: line.note_id, line_ref: line.block_ref, line_indent: indent, ...blank,
      line_after_ref: near && !near.under ? nearRef : null, line_under_ref: near?.under ? nearRef : null, line_at_start: near === null,
    };
    await trashNode(actor, workspaceId, id, { uiContext: TASK_DELETE_CONTEXT, txMeta: meta });
    return "done";
  });
}

/** Bring back task `id`, deleted as a line of its note: the task (as undeleteNode does) and its line, at the place it left.
 *  Returns "not_a_line", having done nothing, when the delete in force did not take a line out: the caller undeletes it as any node.
 *  A note that is gone or unreadable to the actor (canPlaceUnder false) keeps the task without its line. A note the actor can read but no
 *  longer write makes canPlaceUnder throw 403: the whole undo is refused and the task stays deleted. */
export async function undeleteTaskLine(authenticated: ActorCtx | null, id: string): Promise<TaskLineOutcome> {
  const workspaceId = await getWorkspaceId();
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    const meta = await deleteEventMeta(workspaceId, id) as (Partial<LineMeta> & { ui_context?: string }) | null;
    if (meta?.ui_context !== TASK_DELETE_CONTEXT || typeof meta.line_note_id !== "string") return "not_a_line";
    await undeleteNode(actor, workspaceId, id);
    const note = meta.line_note_id;
    // false: the note is gone or unreadable, the task returns alone. Readable but not writable throws (403) and rolls the undo back whole.
    if (!(await canPlaceUnder(actor, workspaceId, note))) return "done";
    const task = await taskRowById(workspaceId, id);
    if (!task) return "done";
    const tryPlace = async (place: LinePlace) => writeTaskLine({
      workspaceId, actor, noteId: note, taskId: id, task, place, reuseRef: meta.line_ref,
      // Events from before the counts were recorded have none: the usual spacing.
      blank: typeof meta.line_blank_above === "number" && typeof meta.line_blank_below === "number" ? { above: meta.line_blank_above, below: meta.line_blank_below } : undefined,
      event: { uiContext: "task.undelete", cascadeLabel: "task.undelete.cascade", backupPrefix: "TASK_UNDELETE" },
    });
    const original: LinePlace = meta.line_at_start ? "start"
      : meta.line_after_ref ? { afterRef: meta.line_after_ref, indent: meta.line_indent }
      : meta.line_under_ref ? { underRef: meta.line_under_ref, indent: meta.line_indent ?? "" } : "end";
    // Items that were nested under the line go back under it; else where it sat among its siblings; else the end of the note.
    const wants: LinePlace[] = [...(meta.line_before_ref ? [{ beforeRef: meta.line_before_ref, indent: meta.line_indent ?? "" }] : []), original];
    for (const want of wants) {
      try {
        await tryPlace(want);
        return "done";
      } catch (e) {
        // The block it followed is gone: the next choice, in the end the end of the note, keeps the line in the note rather than losing it.
        if (!(e instanceof TaskUpdateRefusal && e.error === "block_not_found")) throw e;
      }
    }
    await tryPlace("end");
    return "done";
  });
}

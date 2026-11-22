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
//   delete  (deletion.ts) uses the same line removal (`takeLineOut`) and writing (`writeTaskLine`): the task's line leaves
//           the note and the task goes to the trash, and undoing the delete writes the line back.
//
// One event transaction each: the task's move, the note's edit (its normal
// save: events, versions, block nodes) and the link commit or roll back
// together, under the current actor's rights on both the task and the note.
// A task takes the note's space; when that is another space the task is moved
// there first (spaces.moveToSpace, which has its own rules for who may).

import { z } from "zod";
import { anchoredBlocks, withLineTime, BLOCK_ID } from "@onden/markdown";
import { anchorHolderNote, freeAnchorId, noteAnchorRanges, parseNoteBlocks, retireAnchor } from "../../services/blockAnchors/index.js";
import { q, getWorkspaceId } from "../../db.js";
import { db } from "../../dbKysely.js";
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

/** `body` without the task line that starts at `blockStart`. Only the line itself goes; items nested under it stay in
 *  the note. The blank line placing a task after a paragraph (or at the end) added goes with it. */
function withoutLine(body: string, blockStart: number): string {
  const from = body.lastIndexOf("\n", blockStart - 1) + 1;
  const nl = body.indexOf("\n", blockStart);
  const to = nl === -1 ? body.length : nl + 1;
  const before = body.slice(0, from);
  let after = body.slice(to);
  if (before.endsWith("\n\n") && after.startsWith("\n")) after = after.slice(1);
  // A line at the very start leaves no blank lines at the top of the note.
  if (before === "") after = after.replace(/^(?:[ \t]*\n)+/, "");
  return after === "" && before.endsWith("\n\n") ? before.slice(0, -1) : before + after;
}

/** The line above `lineStart` that says where a line of indent `indentLen` belongs, or null when there is none. Blank lines,
 *  the deeper lines of the previous sibling and the indented continuation text of an item are skipped; then
 *  - a list item at the same indent, or any text at the top level, is its previous sibling (`under: false`: it goes after it);
 *  - a list item at a smaller indent, or a heading, is what it sits under (`under: true`: it is the first thing there).
 *  Text that is not a list item is never a parent: the task after a paragraph or a code fence follows that block.
 *  `at` is where that line starts. */
export function neighbourBefore(body: string, lineStart: number, indentLen: number): { at: number; under: boolean } | null {
  let end = lineStart;
  while (end > 0) {
    const lineEnd = end - 1;
    const start = lineEnd === 0 ? 0 : body.lastIndexOf("\n", lineEnd - 1) + 1;
    const line = body.slice(start, lineEnd);
    end = start;
    if (line.trim() === "") continue;
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (indent > indentLen) continue;
    if (/^[ \t]*#{1,6}\s/.test(line)) return { at: start, under: true };
    if (LIST_ITEM.test(line)) return { at: start, under: indent < indentLen };
    if (indent > 0) continue; // an item's continuation text: the item above it is the neighbour
    return { at: start, under: false };
  }
  return null;
}

/** Where the first item nested deeper than `indentLen` starts, when `body` has one right where a line of that indent was (at `lineStart`,
 *  blank lines skipped): the items a deleted line leaves behind. null when what follows is not deeper. */
export function firstNestedAfter(body: string, lineStart: number, indentLen: number): number | null {
  for (let start = lineStart; start < body.length;) {
    const nl = body.indexOf("\n", start);
    const line = body.slice(start, nl === -1 ? body.length : nl);
    if (line.trim() !== "") return /^[ \t]*/.exec(line)![0].length > indentLen ? start : null;
    if (nl === -1) break;
    start = nl + 1;
  }
  return null;
}

/** Where the last text above the line starting at `lineStart` ends (the index of its newline), or null when there is none. */
function endOfTextAbove(body: string, lineStart: number): number | null {
  for (let end = lineStart; end > 0;) {
    const start = body.lastIndexOf("\n", end - 2) + 1;
    if (body.slice(start, end - 1).trim() !== "") return end - 1;
    end = start;
  }
  return null;
}

/** How many blank lines stand directly above the line that starts at `lineStart` of `body`, and directly below it. */
export function blankAround(body: string, lineStart: number): { above: number; below: number } {
  let above = 0;
  for (let end = lineStart; end > 0; above++) {
    const start = body.lastIndexOf("\n", end - 2) + 1;
    if (body.slice(start, end - 1).trim() !== "") break;
    end = start;
  }
  const lineEnd = body.indexOf("\n", lineStart);
  const below = lineEnd === -1 ? "" : /^(?:[ \t]*\n)*/.exec(body.slice(lineEnd + 1))![0];
  return { above, below: below.split("\n").length - 1 };
}

/** Where the text of the parent starting at `start` ends (the index of its last newline): its first line and, for a list item,
 *  the indented continuation text under it, which stays above the item's first child. */
function endOfParentText(body: string, start: number): number {
  const lineStart = body.lastIndexOf("\n", start - 1) + 1;
  let end = body.indexOf("\n", start);
  if (end === -1) return body.length;
  if (!LIST_ITEM.test(body.slice(lineStart, end))) return end;
  const parentIndent = /^[ \t]*/.exec(body.slice(lineStart))![0].length;
  for (;;) {
    const from = end + 1;
    if (from >= body.length) return end;
    const nl = body.indexOf("\n", from);
    const text = body.slice(from, nl === -1 ? body.length : nl);
    if (text.trim() === "" || LIST_ITEM.test(text) || /^[ \t]*/.exec(text)![0].length <= parentIndent) return end;
    end = nl === -1 ? body.length : nl;
    if (nl === -1) return end;
  }
}

const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])\s/;

/** Where a task line is written: after the block with this anchor (and its nested items), as the first thing under the
 *  block with this anchor (a list item or a heading; written at `indent`), right before the block with this anchor (an item that
 *  was nested under the line; written at `indent`), at the very start of the note, or at its end. */
export type LinePlace = { afterRef: string; indent?: string } | { underRef: string; indent: string } | { beforeRef: string; indent: string } | "start" | "end";

/** Write task `taskId` into note `noteId` as a checkbox line at `place`, inside the caller's event transaction, as the
 *  note's normal save. The task is adopted for the line (blockTasks.ts), not made again. Returns the line's anchor id.
 *  Refuses 404 `block_not_found` when `place` names a block the note no longer has. */
export async function writeTaskLine(opts: {
  workspaceId: string; actor: ActorCtx; noteId: string; taskId: string;
  task: { title: string; status: string; time: string | null; until: string | null };
  place: LinePlace;
  /** Blank lines the line had directly above and below it (blankAround): the text around it comes back as it was. Absent: placing a task, the usual spacing. */
  blank?: { above: number; below: number };
  event: { uiContext: string; cascadeLabel: string; backupPrefix: string };
  /** The anchor id the line had before (undoing a delete): taken back for the line when it is still the note's and stands nowhere, so links to the line keep working. */
  reuseRef?: string;
}): Promise<string> {
  const { workspaceId, actor, noteId, taskId, task, place } = opts;
  const body = (await db.selectFrom("content_nodes").select("markdown").where("id", "=", noteId).where("workspace_id", "=", workspaceId).forUpdate().executeTakeFirst())?.markdown ?? "";
  const anchors = await noteAnchorRanges(workspaceId, noteId);
  const reuse = opts.reuseRef !== undefined && !anchors.some((a) => a.id === opts.reuseRef) && await anchorHolderNote(workspaceId, opts.reuseRef) === noteId;
  const ref = reuse ? opts.reuseRef! : await freeAnchorId(workspaceId);
  const afterRef = typeof place === "object" && "afterRef" in place ? place.afterRef : null;
  const underRef = typeof place === "object" && "underRef" in place ? place.underRef : null;
  const beforeRef = typeof place === "object" && "beforeRef" in place ? place.beforeRef : null;
  const before = beforeRef !== null ? anchoredBlocks(body, anchors).find((b) => b.id === beforeRef) : null;
  if (beforeRef !== null && !before) throw new TaskUpdateRefusal(404, "block_not_found");
  const anchor = afterRef !== null ? anchorAfter(body, afterRef, anchors) : null;
  if (afterRef !== null && !anchor) throw new TaskUpdateRefusal(404, "block_not_found");
  const parent = underRef !== null ? anchoredBlocks(body, anchors).find((b) => b.id === underRef) : null;
  if (underRef !== null && !parent) throw new TaskUpdateRefusal(404, "block_not_found");
  const box = task.status === "done" ? "x" : " ";
  const lineText = `- [${box}] ${withLineTime(lineTitle(task.title), task.time, task.until)} {${await taskLineWord(workspaceId)}}`;
  // The line's block gets the anchor `ref` as the note is saved (adoptAnchors): the task is adopted for it by that id.
  let prefix: string; // everything up to where the line's text starts
  let markdown: string;
  if (place === "start") {
    prefix = "";
    markdown = `${lineText}\n${body === "" ? "" : "\n".repeat(opts.blank?.below ?? (LIST_ITEM.test(body) ? 0 : 1))}${body}`;
  } else if (place === "end") {
    prefix = `${body}${body === "" || body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n"}`;
    markdown = `${prefix}${lineText}\n`;
  } else {
    // After the text that ends at `end` (a block's end, a parent's first line, or the last text above the block it goes before),
    // with the blank lines there rebuilt around the line.
    const beforeAt = before ? body.lastIndexOf("\n", before.start - 1) + 1 : 0;
    const end = anchor ? anchor.end : before ? endOfTextAbove(body, beforeAt) : endOfParentText(body, parent!.start);
    const indent = anchor ? ((place as { indent?: string }).indent ?? (anchor.listItem ? anchor.indent : "")) : (place as { indent: string }).indent;
    const gap = end === null ? "" : /^\n(?:[ \t]*\n)*/.exec(body.slice(end))?.[0] ?? "";
    const next = end === null ? body.slice(beforeAt) : body.slice(end + gap.length);
    const gapBlanks = Math.max(0, gap.split("\n").length - 2);
    const nextIsItem = LIST_ITEM.test(next);
    // Not recorded (placing a task): a paragraph is set off by a blank line and a list item sits right under its sibling;
    // under a parent the line goes after the blank lines there, and text that is not a list item gets a blank line before it.
    const above = opts.blank?.above ?? (anchor ? (anchor.listItem ? 0 : 1) : gapBlanks);
    const below = opts.blank?.below ?? (anchor ? (anchor.listItem || !nextIsItem ? gapBlanks : 0) : next !== "" && !nextIsItem ? 1 : 0);
    // Nothing above (end null): the line is the first of the note.
    prefix = end === null ? "" : `${body.slice(0, end)}\n${"\n".repeat(above)}${indent}`;
    markdown = `${prefix}${lineText}\n${next === "" ? "" : "\n".repeat(below) + next}`;
  }
  // The note's save makes the line's block node; the task is adopted for it instead of a new task being made from the line.
  const release = adoptTaskForLine(noteId, ref, taskId);
  try {
    await updateNode(workspaceId, noteId, { markdown }, {
      actor, baseMarkdown: body, adoptAnchors: [{ anchorId: ref, text: lineText, at: prefix.length, kind: reuse ? "return" : "new" }], event: opts.event,
    });
  } finally {
    release();
  }
  return ref;
}

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

    // The task goes where the note is: its space, then under the note.
    if (task.space_id !== note.space_id && note.space_id) {
      await moveToSpace(actor, workspaceId, id, note.space_id, null);
    }
    await updateNode(workspaceId, id, { parent_id: input.note_id }, { actor });
    // Where the line goes: after the block named, else at the end of the note.
    const ref = await writeTaskLine({
      workspaceId, actor, noteId: input.note_id, taskId: id, task,
      place: input.after_block_ref === undefined ? "end" : { afterRef: input.after_block_ref },
      event: { uiContext: "task.place", cascadeLabel: "task.place.cascade", backupPrefix: "TASK_PLACE" },
    });
    return ref;
  });
  return { ...(await taskRowById(workspaceId, id))!, block_ref: placed };
}

/** The live note holding task `taskId` as a line (the note row is locked FOR UPDATE), or undefined when it is no note's line. */
export async function lineOfTask(workspaceId: string, taskId: string): Promise<{ note_id: string; block_ref: string; markdown: string | null } | undefined> {
  return (await q<{ note_id: string; block_ref: string; markdown: string | null }>(
    `SELECT b.note_id::text, b.block_ref, n.markdown FROM block_nodes b
       JOIN content_nodes n ON n.id = b.note_id JOIN content_nodes t ON t.id = b.task_id
      WHERE b.workspace_id = $1 AND b.task_id = $2 AND b.hidden_at IS NULL AND ${liveNodeSql("n")} AND ${liveNodeSql("t")}
      FOR UPDATE OF n`, [workspaceId, taskId])).rows[0];
}

/** Let go of the link between task `taskId` and its line: a line that goes while its task is still linked would send the
 *  task to the trash with it (blockTasks.ts). */
async function unlinkTaskLine(workspaceId: string, taskId: string): Promise<void> {
  await db.updateTable("block_nodes").set({ task_id: null }).where("workspace_id", "=", workspaceId).where("task_id", "=", taskId).execute();
}

/** Take the line of task `taskId` (anchor `ref`, starting at `blockStart` of `body`) out of note `noteId` as the note's normal save, inside the
 *  caller's event transaction. Returns the saved body. The link is cut first (a line that goes while its task is still linked would send the
 *  task to the trash with it, blockTasks.ts). The anchor is retired twice, on purpose: before the save, because a valid anchor of a removed line
 *  collapses onto the spot it left and claims the next block there (an indented child item), which then loses its own anchor and task link; and
 *  after it, because the save turns a lost anchor into a "maybe" that guesses at a block reading alike, and a line taken out on purpose has no guess. */
export async function takeLineOut(opts: {
  workspaceId: string; actor: ActorCtx; noteId: string; taskId: string; ref: string; body: string; blockStart: number;
  event: { uiContext: string; cascadeLabel: string; backupPrefix: string };
}): Promise<string> {
  const { workspaceId, actor, noteId, taskId, ref, body } = opts;
  await unlinkTaskLine(workspaceId, taskId);
  await retireAnchor(workspaceId, noteId, ref);
  const without = withoutLine(body, opts.blockStart);
  await updateNode(workspaceId, noteId, { markdown: without }, { actor, baseMarkdown: body, event: opts.event });
  await retireAnchor(workspaceId, noteId, ref);
  return without;
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
    const line = await lineOfTask(workspaceId, id);
    if (line) {
      if (!(await canPlaceUnder(actor, workspaceId, line.note_id))) throw new TaskUpdateRefusal(404, "note not found");
      const body = line.markdown ?? "";
      const block = (await parseNoteBlocks(workspaceId, line.note_id, body)).find((b) => b.ref === line.block_ref);
      // Let go of the link first: a line that goes while its task is still
      // linked would send the task to the trash with it (blockTasks.ts).
      if (block) {
        await takeLineOut({
          workspaceId, actor, noteId: line.note_id, taskId: id, ref: line.block_ref, body, blockStart: block.start,
          event: { uiContext: "task.unplace", cascadeLabel: "task.unplace.cascade", backupPrefix: "TASK_UNPLACE" },
        });
      } else {
        await unlinkTaskLine(workspaceId, id);
      }
    }
    await updateNode(workspaceId, id, { parent_id: null }, { actor });
  });
  return (await taskRowById(workspaceId, id))!;
}

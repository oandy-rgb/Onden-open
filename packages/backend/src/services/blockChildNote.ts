// A block of a note ↔ a child note (docs/architecture/block-nodes.md
// 「搬成子筆記／展開回內文」). Each direction is ONE operation: the note's own
// edit is the root event, and everything else it needs — the child note, its
// tags, the references in other notes, the trash — is written inside that
// event's transaction as its cascade. So the whole thing commits or rolls back
// together, and restoring the root event (cascade) is the one undo.
//
//   moveSelectionToChildNote  the same for a selected text (across paragraphs,
//                          or half of one): see @onden/markdown planSelectionMove.
//   moveBlockToChildNote   block → `![[child]]`; references to the block follow
//                          (`[[Note#^id]]` → `[[child]]`); `{tags}` become the
//                          child's tags; review schedules are copied over.
//   expandChildNote        `![[child]]` → the child's text as a block with its
//                          `{tags}` again (a paragraph that stood alone gets its anchor back, so its row,
//                          task, schedule and links never changed); references follow back;
//                          the child goes to the trash.
//
// Pure text rules (what moves, how links change) are @onden/markdown
// blockChild.ts. What this file adds is who may do it and what else is held
// by the block:
//   - references are rewritten only in notes the actor may write. A reference
//     in a note they may not edit would be left pointing at a place that is
//     gone, so by default the operation is refused and says which notes
//     (`unwritable: "refuse"`); `"leave"` goes on and leaves those links as
//     they are. Expanding never leaves any (the child note is going away).
//   - a task line (a block with a task) is refused: the task hangs on the
//     note, and moving it would drop its due date (block-nodes.md B4);
//   - review schedules are copied, not moved: the hidden source rows stay, so
//     undoing brings the block back with its schedule.

import { q } from "../db.js";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import {
  noteNamer, planBlockExpand, planBlockMove, planSelectionMove, qualifyLocalLinks, retargetToChild, retargetToParent, wholeNoteEmbedLines,
  clampNoteTitle, anchoredBlocks, blockSpans, type BlockExpandRefusal, type BlockMoveRefusal,
} from "@onden/markdown";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { assertAuthority, AuthorityError } from "../spine/authority.js";
import { ScopeError } from "../spine/toolScope.js";
import { canReadNode, publiclyReadableNodeIds } from "./readPolicy.js";
import { updateNode, writtenSave } from "./nodeUpdate.js";
import { createNote } from "./noteCreate.js";
import { trashNode } from "./nodeTrash.js";
import { nodeAliasesSql, wikilinkTargets } from "./wikilinkEdges.js";
import { fullTagPath } from "./tagHierarchy.js";
import { reviewSeam } from "./reviewSeam.js";
import { keptOffFromNote } from "./systemAttributes.js";
import { taskLineWord } from "./tasksStore.js";
import { blockSpanAt, freeAnchorId, listNoteAnchors, noteAnchorRanges, rehomeAnchor, type AdoptAnchor } from "./blockAnchors/index.js";
import { liveNodeSql } from "../spine/nodeSql.js";
import { isNote } from "@onden/markdown/contract";

export type BlockChildCode =
  | "note_not_found" | "block_not_found" | "block_not_saved" | "block_unsupported" | "note_too_long"
  | "selection_changed" | "selection_empty"
  | "block_has_task_line" | "references_unwritable"
  | "embed_not_found" | "embed_ambiguous" | "child_not_child" | "child_has_children" | "child_has_properties" | "child_kept_off" | "child_is_task"
  | BlockExpandRefusal;

/** The operation is refused, with nothing written. `detail` carries what the
 *  caller shows (the notes that cannot be rewritten). */
export class BlockChildError extends Error {
  constructor(readonly code: BlockChildCode, readonly status: 404 | 409 | 422, readonly detail?: Record<string, unknown>) {
    super(code);
    this.name = "BlockChildError";
  }
}

/** What to do about a reference in a note the actor may not edit. */
export type UnwritablePolicy = "refuse" | "leave";

export type BlockChildResult = {
  /** The note the block was in / the embed was in, as saved. */
  note: Record<string, unknown>;
  /** The id of the child note (new, or the one that was taken back). */
  childId: string;
  /** The root event: restoring it with cascade undoes everything. */
  eventId: string;
  /** Notes whose references were rewritten. */
  rewritten: Array<{ id: string; title: string }>;
  /** Notes whose references were left alone (`unwritable: "leave"`). */
  left: Array<{ id: string; title: string }>;
};

type NoteRow = {
  id: string; title: string; slug: string; markdown: string; parent_id: string | null;
  space_id: string | null; node_type: string; deleted_at: string | null; aliases: string[];
};

async function loadNote(workspaceId: string, id: string): Promise<NoteRow | null> {
  return (await q<NoteRow>(
    `SELECT n.id::text, n.title, n.slug, n.markdown, n.parent_id::text, n.space_id::text, n.node_type, n.deleted_at::text,
            ${nodeAliasesSql("n")} AS aliases
       FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = $2 AND ${liveNodeSql("n")} FOR UPDATE OF n`,
    [workspaceId, id],
  )).rows[0] ?? null;
}

const asNames = (note: NoteRow) => ({ id: note.id, title: note.title, slug: note.slug, aliases: note.aliases });

/** Live notes of `space` other than `exclude` whose text may hold one of
 *  `needles` (a cheap filter; the exact rule is the rewrite's). A plain substring test,
 *  not LIKE: the text index (pgroonga) answers LIKE patterns with `(` or CJK
 *  punctuation wrongly. */
async function candidateNotes(workspaceId: string, spaceId: string | null, exclude: string[], needles: string[]) {
  return (await q<{ id: string; title: string; markdown: string }>(
    `SELECT id::text, title, markdown FROM content_nodes
      WHERE workspace_id = $1 AND ${liveNodeSql()} AND node_type = 'content'
        AND id <> ALL($2::uuid[]) AND space_id IS NOT DISTINCT FROM $3::uuid
        AND strpos(markdown, '[[') > 0
        AND EXISTS (SELECT 1 FROM unnest($4::text[]) AS needle WHERE strpos(lower(markdown), lower(needle)) > 0)`,
    [workspaceId, exclude, spaceId, needles],
  )).rows;
}

type Rewrite = { id: string; title: string; before: string; after: string };

/** The acting person as they are now, and the note under the event lock, which
 *  they may write. */
async function writableNote(authenticated: ActorCtx, workspaceId: string, noteId: string) {
  const actor = await resolveCurrentActor(authenticated, workspaceId);
  const note = await loadNote(workspaceId, noteId);
  if (!note || !isNote(note)) throw new BlockChildError("note_not_found", 404);
  await assertAuthority(actor, { kind: "node", nodeId: noteId, op: "write_node" });
  return { actor, note };
}

/** The candidates `change` actually alters, with their new text. */
function rewritesOf(candidates: Array<{ id: string; title: string; markdown: string }>, change: (markdown: string) => { markdown: string; count: number }): Rewrite[] {
  return candidates.flatMap((c) => {
    const out = change(c.markdown);
    return out.count > 0 ? [{ id: c.id, title: c.title, before: c.markdown, after: out.markdown }] : [];
  });
}

/** Which of `rewrites` the actor may write; the rest are named so a person can
 *  decide. A note the actor cannot read is only counted. */
async function splitWritable(actor: ActorCtx, rewrites: Rewrite[]) {
  const writable: Rewrite[] = [], blocked: Rewrite[] = [];
  for (const rewrite of rewrites) {
    try {
      await assertAuthority(actor, { kind: "node", nodeId: rewrite.id, op: "write_node" });
      writable.push(rewrite);
    } catch (error) {
      if (!(error instanceof AuthorityError || error instanceof ScopeError)) throw error;
      blocked.push(rewrite);
    }
  }
  return { writable, blocked };
}

async function unwritableDetail(actor: ActorCtx, blocked: Rewrite[]) {
  const readable: Array<{ id: string; title: string }> = [];
  for (const note of blocked) if (await canReadNode(actor, note.id)) readable.push({ id: note.id, title: note.title });
  return { notes: readable, hidden_count: blocked.length - readable.length };
}

/** Rewrite a note's text as one step of the operation's event (a plain note
 *  save: version, merge, derived state; no block ids written). */
async function saveRewrite(workspaceId: string, actor: ActorCtx, rewrite: Rewrite, label: string): Promise<void> {
  await updateNode(workspaceId, rewrite.id, { markdown: rewrite.after }, {
    actor, baseMarkdown: rewrite.before,
    event: { uiContext: label, cascadeLabel: `${label}.cascade`, backupPrefix: "NODE_UPDATED" },
  });
}

/** A title `[[title]]` names only the child: not any note the source note can
 *  already link to under that name. */
async function freeTitle(workspaceId: string, source: NoteRow, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const title = n === 1 ? base : `${base} (${n})`;
    if (!(await wikilinkTargets(workspaceId, source.id, [title])).size) return title;
  }
}

type MoveInput = {
  workspaceId: string; actor: ActorCtx; noteId: string;
  fallbackTitle?: string; unwritable?: UnwritablePolicy; childId?: string;
  /** 「獨立出去」: the block keeps its identity (its row, anchor, task and review schedule stay; the row now
   *  points at the child, `detached_note_id`). Without it: the old 「搬成子筆記」 (a task line is refused,
   *  the schedule is copied, the row is hidden). The only difference between the two entries; the text,
   *  the child, the references and the single restorable event are the same. */
  keepIdentity?: boolean;
};

/** The block of `noteId` with anchor `blockRef`, put in a new child note of it.
 *  The block's text leaves the note, a `![[child]]` line takes its place, and
 *  every reference in the workspace follows it. `fallbackTitle` names a block
 *  with no words. Refusals are BlockChildError; authority errors propagate.
 *
 *  moveBlockToChildNote({ workspaceId, actor, noteId, blockRef: "k3f9" }) */
export function moveBlockToChildNote(input: MoveInput & { blockRef: string }): Promise<BlockChildResult> {
  return moveToChildNote(input, (note, anchors) => planBlockMove(note.markdown, input.blockRef, anchors));
}

/** The text `selection` of `noteId` put in a new child note of it, as one
 *  operation like moveBlockToChildNote. `selection` is offsets into the note
 *  as saved and the text the person saw there: a note that changed since
 *  (`selection_changed`, 409) is not moved on a guess.
 *
 *  moveSelectionToChildNote({ workspaceId, actor, noteId, selection: { from: 12, to: 40, text: "…" } }) */
export function moveSelectionToChildNote(input: MoveInput & { selection: { from: number; to: number; text: string } }): Promise<BlockChildResult> {
  const { from, to, text } = input.selection;
  return moveToChildNote(input, (note, anchors) => note.markdown.slice(from, to) === text
    ? planSelectionMove(note.markdown, from, to, anchors)
    : { refused: "selection_changed" as const });
}

async function moveToChildNote(
  input: MoveInput,
  planFor: (note: NoteRow, anchors: Array<{ id: string; from: number; to: number }>) => ReturnType<typeof planBlockMove> | { refused: "selection_changed" },
): Promise<BlockChildResult> {
  const { workspaceId, noteId, unwritable = "refuse" } = input;
  return withEventTransaction(workspaceId, async () => {
    const { actor, note } = await writableNote(input.actor, workspaceId, noteId);

    const anchors = (await listNoteAnchors(workspaceId, noteId)).filter((a) => a.status === "valid")
      .map((a) => ({ id: a.anchorId, from: a.span.from, to: a.span.to }));
    const plan = planFor(note, anchors);
    if ("refused" in plan) {
      const conflict = plan.refused === "block_not_found" || plan.refused === "selection_changed";
      throw new BlockChildError(plan.refused, conflict ? 409 : 422);
    }
    const blockRef = plan.ref;

    // What the block holds besides its text: its tags and tasks, and those of
    // blocks inside it.
    const refs = [...(blockRef ? [blockRef] : []), ...plan.innerRefs];
    const rows = (await q<{ id: string; block_ref: string; task_id: string | null; hidden: boolean; tag_ids: string[]; anchor_id: string | null }>(
      `SELECT b.id::text, b.block_ref, b.task_id::text, b.hidden_at IS NOT NULL AS hidden, b.anchor_id,
              coalesce(array_agg(t.tag_id::text) FILTER (WHERE t.tag_id IS NOT NULL), '{}') AS tag_ids
         FROM block_nodes b LEFT JOIN block_node_tags t ON t.block_node_id = b.id
        WHERE b.workspace_id = $1 AND b.note_id = $2 AND b.block_ref = ANY($3::text[])
        GROUP BY b.id`, [workspaceId, noteId, refs],
    )).rows;
    // The block's own task line goes with it when it keeps its identity; a task line inside it is
    // still refused (its row would be hidden and its task trashed).
    const lineBlocksMove = (r: { block_ref: string; task_id: string | null; hidden: boolean }) =>
      r.task_id && !r.hidden && !(input.keepIdentity && r.block_ref === blockRef);
    if (rows.some(lineBlocksMove)) throw new BlockChildError("block_has_task_line", 409);
    const own = blockRef ? rows.find((r) => r.block_ref === blockRef && !r.hidden) : undefined;
    // `{tags}` written but no row yet: the note has not been saved with them.
    if (plan.tags.length && !own) throw new BlockChildError("block_not_saved", 409);

    const sanitized = clampNoteTitle((input.fallbackTitle ?? "").replace(/[[\]|#^\\\r\n]+/g, " ").replace(/\s+/g, " ").trim());
    const title = await freeTitle(workspaceId, note, plan.title || sanitized || "Untitled");

    // References to follow the block, in other notes and in this one.
    const namesNote = noteNamer(asNames(note));
    const retarget = (markdown: string, sourceIsHere: boolean) =>
      retargetToChild(markdown, { move: plan, childTarget: title, isSource: namesNote, sourceIsHere });
    const needles = [...refs.map((id) => `#^${id}`), ...plan.headingNames.map((h) => `#${h}`)];
    const candidates = needles.length ? await candidateNotes(workspaceId, note.space_id, [noteId], needles) : [];
    const rewrites = rewritesOf(candidates, (markdown) => retarget(markdown, false));
    const { writable, blocked } = await splitWritable(actor, rewrites);
    if (blocked.length && unwritable === "refuse") throw new BlockChildError("references_unwritable", 409, await unwritableDetail(actor, blocked));

    // This note: the block becomes the embed; its own same-note links follow.
    const replaced = plan.without(title);
    const newMarkdown = retarget(replaced, true).markdown;
    // The moved text's links to other parts of this note must still reach them.
    const body = qualifyLocalLinks(plan.body, { sourceTarget: note.title, local: { ref: blockRef, innerRefs: plan.innerRefs } }).markdown;

    // A task line's task stays on the block, not on the child; `{task}` is not a tag, so nothing to filter.
    const childTagIds = own?.tag_ids ?? [];

    let childId = input.childId ?? "";
    const txMeta = blockRef ? { block_ref: blockRef } : { selection: true };
    const saved = writtenSave(await updateNode(workspaceId, noteId, { markdown: newMarkdown }, {
      actor, baseMarkdown: note.markdown,
      event: {
        uiContext: "block.move_to_child", txMeta,
        cascadeLabel: "block.move_to_child.cascade", backupPrefix: "NODE_UPDATED",
      },
      within: async () => {
        const sort = (await q<{ next: number }>(
          `SELECT coalesce(max(sort_order), -1) + 1 AS next FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2 AND ${liveNodeSql()}`,
          [workspaceId, noteId],
        )).rows[0]!.next;
        // The moved text was on no page of the site if its note was kept off; the child must not make it public:
        // createNote gives a note made under a kept-off one the same default (siteDefault.ts).
        const created = await createNote({
          actor, workspaceId, id: input.childId, title, markdown: body, parentId: noteId, sortOrder: sort, tagIds: childTagIds,
          adoptAnchors: carriedAnchors(note.markdown, anchors, plan, body),
          event: { uiContext: "block.move_to_child.child", txMeta },
        });
        childId = String(created.node.id);
        if (input.keepIdentity && own) await markDetached(workspaceId, own, childId, String(created.node.markdown ?? body), plan.tags);
        for (const rewrite of writable) await saveRewrite(workspaceId, actor, rewrite, "block.move_to_child.reference");
      },
    }));

    // Schedules: the block's becomes the child's; blocks inside keep theirs.
    // Copied after the notes' block rows are in step with the new texts.
    const review = reviewSeam();
    if (review) {
      if (own && !input.keepIdentity) await review.copyProgress(workspaceId, { block: own.id }, { note: childId });
      await copyBlockProgress(workspaceId, noteId, childId, plan.innerRefs);
    }
    return {
      note: saved.node, childId, eventId: saved.eventId,
      rewritten: writable.map(({ id, title: t }) => ({ id, title: t })),
      left: blocked.map(({ id, title: t }) => ({ id, title: t })),
    };
  });
}

/** The anchors of blocks inside the moved text, each on the child's block that is the same text. The child holds the
 *  blocks that start inside the moved span, in the same order and kinds — plus the cut piece of a paragraph the
 *  selection began in the middle of, which comes first. When the two do not line up nothing is carried (those
 *  blocks are new in the child, like any text pasted there): never a guess by position. */
function carriedAnchors(
  source: string, anchors: Array<{ id: string; from: number; to: number }>,
  plan: { innerRefs: string[]; span: { from: number; to: number } }, body: string,
): AdoptAnchor[] {
  if (plan.innerRefs.length === 0) return [];
  const inner = new Set(plan.innerRefs);
  const here = blockSpans(source).filter((s) => s.start >= plan.span.from && s.start < plan.span.to);
  const there = blockSpans(body);
  const skip = there.length - here.length;
  if (skip < 0 || skip > 1 || here.some((s, i) => s.kind !== there[skip + i]!.kind)) return [];
  const anchored = anchoredBlocks(source, anchors).filter((a) => inner.has(a.id));
  return here.flatMap((s, i) => {
    const a = anchored.find((x) => x.start === s.start && x.end === s.end && x.kind === s.kind);
    const d = there[skip + i]!;
    return a ? [{ anchorId: a.id, text: body.slice(d.start, d.end), at: d.start, kind: "carry" as const }] : [];
  });
}

/** The block's row now stands for `childId`: its text is the child's, its anchor is the child's first block.
 *  Nothing else of the row changes — task, schedule and tags stay with it. */
async function markDetached(
  workspaceId: string, row: { id: string; anchor_id: string | null }, childId: string, childMarkdown: string, writtenTags: readonly string[],
): Promise<void> {
  await db.updateTable("block_nodes").set({ detached_note_id: childId, detached_tags: [...writtenTags], updated_at: sql`now()` }).where("id", "=", row.id).execute();
  if (row.anchor_id) {
    await rehomeAnchor(workspaceId, row.anchor_id, childId, childMarkdown, blockSpanAt(childMarkdown, 0) ?? { from: 0, to: childMarkdown.length });
  }
}

/** Each of `refs`' block node in `from` → the block node of `to` that is the same text (same kind and label, in
 *  order: the moved text got its own anchors there), schedule copied. */
async function copyBlockProgress(workspaceId: string, from: string, to: string, refs: string[]): Promise<void> {
  const review = reviewSeam();
  if (!review || refs.length === 0) return;
  const sources = (await q<{ id: string; kind: string; label: string }>(
    `SELECT id::text, kind, label FROM block_nodes
      WHERE workspace_id = $1 AND note_id = $2 AND block_ref = ANY($3::text[]) ORDER BY created_at, id`, [workspaceId, from, refs],
  )).rows;
  const dests = (await q<{ id: string; kind: string; label: string }>(
    `SELECT id::text, kind, label FROM block_nodes
      WHERE workspace_id = $1 AND note_id = $2 AND hidden_at IS NULL ORDER BY created_at, id`, [workspaceId, to],
  )).rows;
  const taken = new Set<string>();
  for (const source of sources) {
    const dest = dests.find((d) => !taken.has(d.id) && d.kind === source.kind && d.label === source.label);
    if (!dest) continue;
    taken.add(dest.id);
    await review.copyProgress(workspaceId, { block: source.id }, { block: dest.id });
  }
}

/** The `![[child]]` line of `noteId` replaced by the child's text, as a block
 *  with its tags in `{…}` again; references to the child point
 *  at that block; the child goes to the trash. Refused when the child has
 *  notes of its own, properties that would be lost, or text that is not one
 *  block; and when a reference cannot be rewritten (never left behind: the
 *  child is going away).
 *
 *  expandChildNote({ workspaceId, actor, noteId, childId }) */
export async function expandChildNote(input: {
  workspaceId: string; actor: ActorCtx; noteId: string; childId: string;
}): Promise<BlockChildResult> {
  const { workspaceId, noteId, childId } = input;
  return withEventTransaction(workspaceId, async () => {
    const { actor, note } = await writableNote(input.actor, workspaceId, noteId);
    const child = await loadNote(workspaceId, childId);
    if (!child || child.parent_id !== noteId || !isNote(child)) throw new BlockChildError("child_not_child", 409);
    await assertAuthority(actor, { kind: "node", nodeId: childId, op: "write_node" });

    const live = (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2 AND ${liveNodeSql()}`, [workspaceId, childId],
    )).rows[0]!.n;
    if (live > 0) throw new BlockChildError("child_has_children", 409);
    // Properties and values hang on the note; a block has no place for them.
    // Keys starting with `_` are the system's own (derived, module state).
    const props = (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM node_attributes WHERE node_id = $1 AND key NOT LIKE '\\_%' AND source NOT IN ('derived', 'markdown')`, [childId],
    )).rows[0]!.n;
    if (props > 0) throw new BlockChildError("child_has_properties", 409);
    // Taking the text back is a deliberate act, but a child that was kept off the site would go out with a note that is
    // on it, so that is for the person to decide first (put the child on the site, or keep this note off).
    if (await keptOffFromNote(childId) && !await keptOffFromNote(noteId) && (await publiclyReadableNodeIds(workspaceId)).has(noteId)) {
      throw new BlockChildError("child_kept_off", 409);
    }

    const tagRows = (await q<{ tag_id: string }>(`SELECT tag_id::text FROM node_tags WHERE node_id = $1`, [childId])).rows;
    let tags = (await Promise.all(tagRows.map((t) => fullTagPath(workspaceId, t.tag_id)))).filter((name) => name !== "");
    // A paragraph that stood alone with its identity (獨立出去): the same row comes back, with the same `^id`,
    // and its `{…}` as it was written when the child's tags are still the ones it left with. Only into the note it
    // left: a child moved under another note comes back there as new text, not as that note's row.
    const standing = await db.selectFrom("block_nodes").select(["id", "block_ref", "anchor_id", "task_id", "detached_tags"])
      .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).where("detached_note_id", "=", childId).executeTakeFirst();
    if (standing) tags = tagsBackInBraces(tags, standing, await taskLineWord(workspaceId));

    const isChild = noteNamer(asNames(child));
    const embeds = wholeNoteEmbedLines(note.markdown, isChild);
    if (embeds.length === 0) throw new BlockChildError("embed_not_found", 409);
    if (embeds.length > 1) throw new BlockChildError("embed_ambiguous", 409);

    const plan = planBlockExpand(note.markdown, embeds[0]!, child.markdown, { tags });
    if ("refused" in plan) throw new BlockChildError(plan.refused, 422);
    // The block's identity: a standing paragraph's anchor comes back with it (applyBodyChange puts it on this text).
    const blockText = plan.markdown.slice(plan.blockStart, plan.blockEnd);
    // No standing row: the text is a block again. If this note still holds the anchor that left with exactly this
    // text (搬成子筆記 hid its row and the anchor went `lost`), that anchor comes back — links that ever named the
    // block work again. Otherwise the id is chosen now so links to the child can name the new block.
    const leftBehind = standing ? [] : (await listNoteAnchors(workspaceId, noteId))
      .filter((a) => a.status !== "valid" && a.quote.text.trimEnd() === blockText.trimEnd());
    const newAnchor = standing ? null : leftBehind.length === 1 ? leftBehind[0]!.anchorId : await freeAnchorId(workspaceId);
    const adoptAnchors = standing?.anchor_id ? [{ anchorId: standing.anchor_id, text: blockText, kind: "return" as const }]
      : newAnchor ? [{ anchorId: newAnchor, text: blockText, at: plan.blockStart, kind: leftBehind.length === 1 ? "return" as const : "new" as const }] : undefined;

    // References to the child become references to the block.
    const retarget = (markdown: string) => retargetToParent(markdown, { ref: standing?.block_ref ?? newAnchor ?? "", sourceTarget: note.title, isChild });
    const candidates = await candidateNotes(workspaceId, note.space_id, [noteId, childId], [child.title, ...child.aliases, child.slug, childId]);
    const rewrites = rewritesOf(candidates, (markdown) => retarget(markdown));
    const { writable, blocked } = await splitWritable(actor, rewrites);
    if (blocked.length) throw new BlockChildError("references_unwritable", 409, await unwritableDetail(actor, blocked));

    const saved = writtenSave(await updateNode(workspaceId, noteId, { markdown: retarget(plan.markdown).markdown }, {
      actor, baseMarkdown: note.markdown, adoptAnchors,
      event: {
        uiContext: "block.expand_child", txMeta: { child_id: childId, ...(standing ? { block_ref: standing.block_ref } : {}) },
        cascadeLabel: "block.expand_child.cascade", backupPrefix: "NODE_UPDATED",
      },
      within: async () => {
        for (const rewrite of writable) await saveRewrite(workspaceId, actor, rewrite, "block.expand_child.reference");
        await trashNode(actor, workspaceId, childId, { uiContext: "block.expand_child.child" });
      },
    }));

    // The child's schedule goes onto the block; blocks inside it keep theirs.
    const review = reviewSeam();
    if (review) {
      // The row that stood alone keeps its own schedule (it is the same row); text that was never a block's takes the
      // child's: the row the note's save made for the block that now starts where the embed stood.
      if (!standing) {
        const startsHere = (await noteAnchorRanges(workspaceId, noteId))
          .filter((a) => a.from >= plan.blockStart && a.from <= plan.blockEnd).sort((a, b) => a.from - b.from).map((a) => a.id);
        // The block's own row is the one whose anchor starts first (the outer block; rows of blocks inside it come after).
        const row = startsHere.length === 0 ? undefined : (await db.selectFrom("block_nodes").select(["id", "anchor_id"])
          .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).where("hidden_at", "is", null)
          .where("anchor_id", "in", startsHere).execute())
          .sort((a, b) => startsHere.indexOf(a.anchor_id!) - startsHere.indexOf(b.anchor_id!))[0];
        if (row) await review.copyProgress(workspaceId, { note: childId }, { block: row.id });
      }
      await copyBlockProgress(workspaceId, childId, noteId, (await listNoteAnchors(workspaceId, childId)).map((a) => a.anchorId));
    }
    return {
      note: saved.node, childId, eventId: saved.eventId,
      rewritten: writable.map(({ id, title: t }) => ({ id, title: t })), left: [],
    };
  });
}

/** The `{…}` names to write when a standing paragraph comes back: what the child's tags say, plus the
 *  task name a task line's row still carries (its tag was kept off the child); in the order written when
 *  it left if that is still the same set. */
function tagsBackInBraces(childTags: string[], row: { task_id: string | null; detached_tags: string[] | null }, taskWord: string): string[] {
  const names = [...childTags];
  const isTask = (name: string) => name.replace(/^#/, "").toLowerCase() === taskWord.toLowerCase();
  if (row.task_id && !names.some(isTask)) names.push(taskWord);
  const key = (list: readonly string[]) => [...new Set(list.map((n) => n.replace(/^#/, "").trim().toLowerCase()))].sort().join("\n");
  return row.detached_tags && key(row.detached_tags) === key(names) ? row.detached_tags.map((n) => n.replace(/^#/, "")) : names;
}

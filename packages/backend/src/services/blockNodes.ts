// Block nodes (docs/architecture/block-nodes.md): blocks of a note upgraded
// to nodes by `{tags}` at their end. The note's text is the source; the
// block_nodes rows follow it on every save, in the writing transaction.
//
//   syncBlockNodes after the body is written (every body change, including
//                  undo and import): the rows, their parents and their own
//                  tags follow the text; each structural change is an event.
//
// A block's identity is its anchor (the anchor table, services/blockAnchors): `block_nodes.block_ref` IS the anchor's
// id and the text carries no `^id`. applyBodyChange moves the note's anchors first; here a block that has `{…}` and
// no anchor at its start gets one (the id the row is then known by), so the same text keeps the same row — and its
// tasks, schedule and links — through every edit, move or undo.
//
// A block node whose `{…}` is gone is hidden, not deleted: its data
// stays for when the text brings it back (doc: 已決定 1), which is also what
// makes undo exact. Rows go only with their note (FK cascade on purge).

import { randomUUID } from "node:crypto";
import { trailingBlockId, blocksParsable, parseBlocks, type ParsedBlock, cutToUnits, derivedIdName } from "@onden/markdown";
import { event, q } from "../db.js";
import { db } from "../dbKysely.js";
import { readableScopeSql } from "./readPolicy.js";
import { LISTED_NODE_SQL } from "../spine/reservedNodes.js";
import { eventActorType, type ActorCtx } from "../types.js";
import { memberTagIds, tagIdForWrittenName } from "./tagHierarchy.js";
import { pageOf, pageSql, type PageInput } from "./paging.js";
import type { Page } from "@onden/contract";
import { log } from "../logger.js";
import { withSavepoint } from "../db.js";
import { trashNode } from "./nodeTrash.js";
import { AuthorityError } from "../spine/authority.js";
import { TASK_TAG_NAME } from "../spine/taskIdentity.js";
import { systemJobOf } from "../spine/systemJobs.js";
import { taskSeam, type TaskLine } from "./taskSeam.js";
import { reviewSeam } from "./reviewSeam.js";
import { insertAnchor, listNoteAnchors, takeBackStrandedAnchors } from "./blockAnchors/index.js";
import { liveNodeSql } from "../spine/nodeSql.js";
import { derivedId } from "./derivedIds.js";

/** What the text cache keeps of a block (a display index, not the source). */
const TEXT_CACHE_MAX = 4000;

type Row = {
  id: string; block_ref: string; parent_block_id: string | null; kind: string;
  label: string; text_cache: string; hidden: boolean; tag_ids: string[]; detached_note_id: string | null;
};

/** The note's block_nodes follow `markdown` (as stored). Call in the writing
 *  transaction, after the body UPDATE; `eventId` is the body change's event. */
export async function syncBlockNodes(change: {
  workspaceId: string; noteId: string; markdown: string; actor: ActorCtx; eventId: string;
}): Promise<void> {
  const { workspaceId, noteId, markdown, actor, eventId } = change;
  // Too long to read: the block nodes stay as they are (BLOCK_PARSE_MAX) —
  // never silently: logged here; the editor shows the note is too long (B2).
  if (!blocksParsable(markdown)) {
    if (markdown.includes("{") || markdown.includes("^")) {
      log.warn("blocks", "note too long for block nodes; left as they are", { workspaceId, noteId, length: markdown.length });
    }
    return;
  }
  // The text of a paragraph a child note of this one holds in the trash is back (its move out was undone): first,
  // its anchor and row come back to it.
  await takeBackStrandedAnchors(workspaceId, noteId, markdown);
  const rows = (await q<Row>(
    `SELECT b.id, b.block_ref, b.parent_block_id, b.kind, b.label, b.text_cache, b.hidden_at IS NOT NULL AS hidden, b.detached_note_id::text,
            coalesce(array_agg(t.tag_id ORDER BY t.tag_id) FILTER (WHERE t.tag_id IS NOT NULL), '{}') AS tag_ids
       FROM block_nodes b LEFT JOIN block_node_tags t ON t.block_node_id = b.id
      WHERE b.workspace_id = $1 AND b.note_id = $2
      GROUP BY b.id`, [workspaceId, noteId],
  )).rows;
  if (rows.length === 0 && !markdown.includes("{") && !markdown.includes("^")) return;

  // A block with `{…}` is a block node, known by its anchor: the valid anchor of this note that starts at it. One
  // that has none gets one now (a paragraph just tagged, an import, an undo). An anchor that is `maybe` or `lost`
  // and points at this block (its candidate) keeps its row in 找不到的段落 — no second row (and no second review card)
  // is made for the same text; the person confirms it. An id repeated by two blocks counts once.
  const stored = await listNoteAnchors(workspaceId, noteId);
  const all = parseBlocks(markdown, stored.filter((a) => a.status === "valid").map((a) => ({ id: a.anchorId, from: a.span.from })));
  const candidateStarts = new Set(stored.filter((a) => a.status !== "valid" && a.candidate).map((a) => startOf(markdown, a.candidate!.from)));
  // An anchor another note's row already answers to (a paragraph standing alone as a note moved it into that note's first
  // block) is not this block's identity: anchor_id is 1:1, so the block gets an anchor of its own.
  const refs = all.flatMap((b) => (b.ref ? [b.ref] : []));
  if (refs.length > 0) {
    const elsewhere = new Set((await db.selectFrom("block_nodes").select("anchor_id")
      .where("workspace_id", "=", workspaceId).where("note_id", "<>", noteId).where("anchor_id", "in", refs).execute()).map((r) => r.anchor_id));
    for (const b of all) if (b.ref && elsewhere.has(b.ref)) b.ref = null;
  }
  for (const b of all) {
    if (b.ref || candidateStarts.has(b.start)) continue;
    b.ref = await insertAnchor(workspaceId, noteId, markdown, { from: b.start, to: b.end }, { actor, eventId });
  }
  const seen = new Set<string>();
  const parsed = all.map((b, index) => ({ b, index })).filter(({ b }) => {
    if (!b.ref || seen.has(b.ref)) return false;
    seen.add(b.ref); return true;
  });
  const byRef = new Map(rows.map((r) => [r.block_ref, r]));
  // `- [ ] … {task}`: `task` (and the tasks module tag's current name, taskSeam.lineWords) is the tasks module's word (B4), not a tag name — it is left out of
  // tag resolution so a save can never make a plain `task` tag. With the module off (or not loaded) no
  // line is a task.
  const tasks = taskSeam();
  const taskWords = new Set(tasks ? await tasks.lineWords(workspaceId) : [TASK_TAG_NAME]);
  const isTaskWord = (name: string): boolean => taskWords.has(writtenTagName(name).toLowerCase());
  const linesAreTasks = tasks ? await tasks.linesAreTasks(workspaceId) : false;
  // `{review}` is the review module's own reserved word (reviewSeam.cardWords), like `{task}`: it makes the paragraph a card (its own
  // function reference, added below) and is never resolved to a tag, so a save can never make a plain `review` tag.
  const review = reviewSeam();
  const reviewWords = new Set(review ? await review.cardWords(workspaceId) : []);
  const isReviewWord = (name: string): boolean => reviewWords.has(writtenTagName(name).toLowerCase());
  const cardBlockIds: string[] = [];
  const wordlessBlockIds: string[] = [];
  const tagIds = await resolveTagNames(workspaceId, noteId, parsed.flatMap(({ b }) => b.tags.filter((t) => !isTaskWord(t) && !isReviewWord(t))), actor);
  const before = new Set(rows.flatMap((r) => r.tag_ids));
  const idOfIndex = new Map<number, string>();
  // Task lines (B4): a task list item carrying #task itself.
  const taskLines: TaskLine[] = [];
  // Block events are about the note: exactly its readers see them (event
  // visibility follows the target; a block's label is the note's text), and
  // undoing the note's edit is what undoes them (restore skips them as
  // unsupported in its cascade).
  const record = (type: string, blockId: string, payload: Record<string, unknown>) =>
    event(workspaceId, type, "node", noteId, { block_node_id: blockId, ...payload }, eventActorType(actor.type), actor.id, { triggeredBy: eventId });

  // Document order: a parent's row exists before its children's.
  for (const { b, index } of parsed) {
    const parentId = parentRowId(all, b, idOfIndex);
    const wantTags = [...new Set(b.tags.flatMap((t) => tagIds.get(t) ?? []))].sort();
    const text = cutToUnits(markdown.slice(b.start, b.end), TEXT_CACHE_MAX);
    const existing = byRef.get(b.ref!);
    const cardWord = b.tags.some(isReviewWord);
    const taskLine = b.checkbox && linesAreTasks && b.tags.some(isTaskWord)
      ? (blockId: string) => taskLines.push({ blockId, ref: b.ref!, title: taskLineTitle(markdown, b), checked: b.checkbox!.checked }) : null;
    if (!existing) {
      // The row's id is derived from its anchor's (services/derivedIds.ts): two nodes that each make the row for the same anchor make the same row, so a merge sees one.
      const id = (await q<{ id: string }>(
        `INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, anchor_id, parent_block_id, kind, label, text_cache)
         VALUES ($8, $1, $2, $3, $3, $4, $5, $6, $7) RETURNING id::text`,
        [workspaceId, noteId, b.ref, parentId, b.kind, b.label, text, await blockRowIdFor(workspaceId, b.ref!)],
      )).rows[0]!.id;
      await setTags(workspaceId, id, wantTags);
      await record("BLOCK_NODE_CREATED", id, { block_ref: b.ref, kind: b.kind, label: b.label, parent_block_id: parentId, tag_ids: wantTags });
      idOfIndex.set(index, id);
      taskLine?.(id);
      if (cardWord) cardBlockIds.push(id);
      continue;
    }
    idOfIndex.set(index, existing.id);
    taskLine?.(existing.id);
    if (cardWord) cardBlockIds.push(existing.id); else wordlessBlockIds.push(existing.id);
    // The text is in this note: the paragraph is not standing alone as a note any more (taken back, or the
    // edit that moved it out was undone). Its tasks and schedule were never touched. The move itself is the
    // note's own edit event; no event of the row's own is written for it.
    if (existing.detached_note_id !== null) {
      await db.updateTable("block_nodes").set({ detached_note_id: null, detached_tags: null }).where("id", "=", existing.id).execute();
    }
    const before = { parent_block_id: existing.parent_block_id, kind: existing.kind, tag_ids: existing.tag_ids, hidden: existing.hidden };
    const after = { parent_block_id: parentId, kind: b.kind, tag_ids: wantTags, hidden: false };
    const structural = JSON.stringify(before) !== JSON.stringify(after);
    if (!structural && existing.label === b.label && existing.text_cache === text) continue;
    await q(
      `UPDATE block_nodes SET parent_block_id = $2, kind = $3, label = $4, text_cache = $5, hidden_at = NULL, updated_at = now()
        WHERE id = $1`, [existing.id, parentId, b.kind, b.label, text],
    );
    if (existing.tag_ids.join() !== wantTags.join()) await setTags(workspaceId, existing.id, wantTags);
    // A text-only change is the note's own edit event; only a change of
    // place, kind, tags or presence is the block node's.
    if (structural) {
      await record(existing.hidden ? "BLOCK_NODE_RESTORED" : "BLOCK_NODE_UPDATED", existing.id, { block_ref: b.ref, before, after });
    }
  }

  const present = new Set(parsed.map(({ b }) => b.ref));
  const stillUsed = new Set(parsed.flatMap(({ b }) => b.tags.flatMap((t) => tagIds.get(t) ?? [])));
  // A paragraph standing alone as a note (detached_note_id) has no text here by design: it stays.
  const removedRows = rows.filter((row) => !row.hidden && row.detached_note_id === null && !present.has(row.block_ref));
  const stillWritten = new Set(stored.filter((a) => a.status === "valid").map((a) => a.anchorId));
  for (const row of removedRows) {
    await q(`UPDATE block_nodes SET hidden_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
    await record("BLOCK_NODE_REMOVED", row.id, { block_ref: row.block_ref, kept: true });
    // Its `{…}` is gone but the paragraph is still in the text (its anchor still finds it): that is "the review word was taken out".
    // A paragraph whose text is gone too keeps its reference like all of its data.
    if (stillWritten.has(row.block_ref) && !row.hidden) wordlessBlockIds.push(row.id);
  }
  await dropUnusedAutoTags(workspaceId, new Set([...before].filter((t) => !stillUsed.has(t))), actor);
  await tasks?.syncLines({ workspaceId, noteId, actor, lines: taskLines });
  // A paragraph that says it is a card is one (its own reference, remembered as made by the word). Taking the word out takes that
  // reference away — the paragraph is no longer a card — but every person's schedule stays, so the word coming back resumes it. A
  // paragraph that is gone from the text (hidden) keeps both, and a card made another way (migration 195, a tag) is not tied to the text.
  // Creating or removing this reference is part of saving the text: it writes no event of its own.
  if (review && cardBlockIds.length > 0) await review.markCards({ workspaceId, holders: cardBlockIds.map((id) => ({ kind: "block" as const, id })), actor, via: "word" });
  if (review && wordlessBlockIds.length > 0) await review.unmarkCardsWord({ holders: wordlessBlockIds.map((id) => ({ kind: "block" as const, id })) });
}

/** The id a new paragraph row of anchor `anchorId` gets: derived from the anchor's (derivedIdName.blockNode), so two nodes that each make the row for one anchor make the same
 *  row; a random one when a row already has that id (a row whose anchor was renamed keeps the id it was made with), so making the row never fails on the derivation. */
async function blockRowIdFor(workspaceId: string, anchorId: string): Promise<string> {
  const id = derivedId(derivedIdName.blockNode(workspaceId, anchorId));
  return (await db.selectFrom("block_nodes").select("id").where("id", "=", id).executeTakeFirst()) ? randomUUID() : id;
}

/** The first character of the line a span starts on, past its indentation: where the parser says its block starts. */
function startOf(markdown: string, from: number): number {
  let at = from;
  while (at < markdown.length && (markdown[at] === " " || markdown[at] === "\t")) at++;
  return at;
}

/** A task line's title: its text after the box, up to its `{…}` — whole,
 *  where the block's label stops at 60 characters. */
function taskLineTitle(markdown: string, block: ParsedBlock): string {
  const from = block.checkbox!.at + 2;
  const nl = markdown.indexOf("\n", from);
  const lineEnd = nl === -1 ? markdown.length : nl;
  const to = block.marks.tags && block.marks.tags.from >= from && block.marks.tags.from <= lineEnd ? block.marks.tags.from : lineEnd;
  const line = markdown.slice(from, to);
  const id = trailingBlockId(line);
  return (id ? line.slice(0, id.start) : line).trim() || block.label;
}

/** The row id of `block`'s parent: the nearest enclosing block node with an
 *  id (an id-less one in between is no node yet, so it is skipped). */
function parentRowId(all: ParsedBlock[], block: ParsedBlock, idOfIndex: Map<number, string>): string | null {
  let p = block.parent;
  while (p !== null) {
    const id = idOfIndex.get(p);
    if (id) return id;
    p = all[p]!.parent;
  }
  return null;
}

async function setTags(workspaceId: string, blockId: string, tagIds: string[]): Promise<void> {
  // Only the difference is written, so a tag that stays keeps its write stamp (db/migrations/194_stamps_s2.sql).
  await q(`DELETE FROM block_node_tags WHERE block_node_id = $1 AND tag_id <> ALL($2::uuid[])`, [blockId, tagIds]);
  if (tagIds.length) {
    await q(
      `INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING`,
      [blockId, tagIds, workspaceId],
    );
  }
}

/** Marks a tag a block save created (value: the note), so the tag can go
 *  again if the block drops it before anything else uses it — a name caught
 *  mid-typing (`{重}` before `{重要}`) must not stay behind as a tag. */
const AUTO_TAG_KEY = "_block_autotag";

/** A tag name as written in `{…}` or as `#tag`, without the `#`. */
const writtenTagName = (name: string): string => name.replace(/^#/, "").trim();

/** Tag names (as written in `{…}` or as `#tags`) → class_tag ids, keyed by the
 *  name exactly as given. Each resolves by the one written-name rule
 *  (tagHierarchy.tagIdForWrittenName: from the root, exact title first, else
 *  the one case-insensitive match), as frontmatter tags and quick capture do;
 *  a name that names no tag creates it, as an inline `#新標籤` does, marked as
 *  the block save's. A name with no segment (`{/}`) maps to nothing. */
async function resolveTagNames(workspaceId: string, noteId: string, names: string[], actor: ActorCtx): Promise<Map<string, string>> {
  const idOf = new Map<string, string>();
  for (const name of new Set(names.map(writtenTagName))) {
    // A system job (rewriting a note's text, not tagging it) holds no authority to make a tag: a name that names none stays unresolved.
    const { id, created } = await tagIdForWrittenName(workspaceId, name, { create: !systemJobOf(actor), actor });
    if (!id) continue;
    for (const tagId of created) {
      await q(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
         VALUES ($1, $2, $3, $4, 'text', 'derived') ON CONFLICT (node_id, key) DO NOTHING`,
        [workspaceId, tagId, AUTO_TAG_KEY, noteId],
      );
    }
    idOf.set(name, id);
  }
  // `{a, #a}` land on one tag; `{A}` too, unless a tag titled exactly `A` exists.
  const out = new Map<string, string>();
  for (const n of names) {
    const id = idOf.get(writtenTagName(n));
    if (id) out.set(n, id);
  }
  return out;
}

/** Tags this save's blocks dropped that a block save created and nothing
 *  uses now (no note, no block, no child tag, no schema or page text): moved
 *  to the trash, as a stray caught mid-typing. Anything else keeps them. */
async function dropUnusedAutoTags(workspaceId: string, dropped: Set<string>, actor: ActorCtx): Promise<void> {
  if (dropped.size === 0) return;
  // Lock the tags before asking whether anything uses them: a write giving
  // one a member (node_tags / block_node_tags) holds a key-share lock on it
  // through the foreign key, which FOR UPDATE waits for — so a member added
  // concurrently is either seen below or added after this decision commits.
  await q(
    `SELECT id FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND ${liveNodeSql()} ORDER BY id FOR UPDATE`,
    [workspaceId, [...dropped]],
  );
  const unused = (await q<{ id: string }>(
    `SELECT t.id::text FROM content_nodes t
       JOIN node_attributes a ON a.node_id = t.id AND a.key = $3
      WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[]) AND ${liveNodeSql("t")}
        AND t.tag_schema IS NULL AND t.reserved_key IS NULL AND coalesce(t.markdown, '') = ''
        AND NOT EXISTS (SELECT 1 FROM node_tags nt WHERE nt.tag_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM block_node_tags bt WHERE bt.tag_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = t.id AND ${liveNodeSql("c")})`,
    [workspaceId, [...dropped], AUTO_TAG_KEY],
  )).rows;
  for (const { id } of unused) {
    // Its own savepoint: a tag this actor may not trash just stays.
    try {
      await withSavepoint(() => trashNode(actor, workspaceId, id, { uiContext: "block.tag.unused" }));
    } catch (error) {
      if (!(error instanceof AuthorityError)) throw error;
    }
  }
}

// ── Queries (B1c) ───────────────────────────────────────────────────────────
// A block node has only the tags written in its own `{…}`: none come down from the block above or the note, as a
// note takes none from its parent (owner 2026-11-09, docs/architecture/block-nodes.md §5).

/** A block node a tag's page lists: its words, and the note it is in. */
export type TagBlockRow = { id: string; note_id: string; note_title: string; label: string };

/** One page of the block nodes carrying `tagId` or one of its member tags themselves (tagHierarchy.memberTagIds,
 *  the rule the page lists its notes by), in notes the reader can read: by note title, then where in the note. */
export async function tagBlocks(actor: ActorCtx, workspaceId: string, tagId: string, page: PageInput): Promise<Page<TagBlockRow>> {
  const params: unknown[] = [workspaceId];
  const blocks = blockQuerySql(params, { tagIds: await memberTagIds(workspaceId, tagId), actor });
  const rows = (await q<TagBlockRow & { total: string }>(
    `WITH hits AS (${blocks})
     SELECT h.block_id::text AS id, h.note_id::text, n.title AS note_title, h.label, count(*) OVER () AS total
       FROM hits h JOIN content_nodes n ON n.id = h.note_id
      ORDER BY n.title, n.id, h.block_at, h.block_id
      ${pageSql(page, params)}`,
    params,
  )).rows;
  const { rows: listed, next } = pageOf(rows.map(({ total: _total, ...row }) => row), page);
  return { rows: listed, total: Number(rows[0]?.total ?? 0), next };
}

/** The SQL of the block nodes a tag query lists (§9), for a query to put beside its notes (services/nodeQuery.ts):
 *  blocks whose own tags hold one of `tagIds`. Only blocks of notes the reader can read, live, not hidden and not
 *  system machinery (the reader's scope over the alias `n`). It yields (note_id, block_id, block_ref, label,
 *  block_at). Its parameters are pushed onto `params`, whose $1 must be the workspace id. */
export function blockQuerySql(params: unknown[], opts: {
  tagIds: string[];
  /** Whose reading rights apply. */
  actor: ActorCtx | null;
  /** List only blocks of these notes (a published subset). */
  within?: readonly string[];
}): string {
  const tags = params.push(opts.tagIds);
  const scope = `n.hidden = false AND ${liveNodeSql("n")} AND ${LISTED_NODE_SQL("n")} AND ${readableScopeSql(opts.actor, "n", params)}`
    + (opts.within ? ` AND n.id = ANY($${params.push(opts.within)}::uuid[])` : "");
  return `SELECT b.note_id, b.id AS block_id, b.block_ref, b.label, b.created_at AS block_at
       FROM block_nodes b JOIN content_nodes n ON n.id = b.note_id
      WHERE b.workspace_id = $1 AND b.hidden_at IS NULL AND b.detached_note_id IS NULL AND ${scope}
        AND EXISTS (SELECT 1 FROM block_node_tags bt WHERE bt.block_node_id = b.id AND bt.tag_id = ANY($${tags}::uuid[]))`;
}

/** A recurring task written as a line of a note: the line stands for the occurrence that is current. Lines that point at
 *  `fromTaskId` point at `toTaskId` afterwards: on to the next occurrence when one is made, back when the earlier one is
 *  open again (a line that has moved further on no longer points at `fromTaskId` and is left). Runs in the caller's
 *  transaction; each occurrence keeps its own history. */
export async function moveTaskLine(workspaceId: string, fromTaskId: string, toTaskId: string): Promise<void> {
  await db.updateTable("block_nodes").set({ task_id: toTaskId })
    .where("workspace_id", "=", workspaceId).where("task_id", "=", fromTaskId).execute();
}

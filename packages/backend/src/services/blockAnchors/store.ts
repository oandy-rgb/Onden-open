// block_anchors reads and writes. The only code that touches the table.
//
// Moving is called from bodySideEffects.applyBodyChange — inside the transaction that wrote the body,
// so a note's text and its anchors' positions commit or roll back together. Nothing else moves anchors
// (src/test/guards/bodyAnchors.guard.test.ts).

import { cutToUnits, newBlockId, parseBlocks, blockSpans, excerptBlockSpans, type ParsedBlock } from "@onden/markdown";
import { q, event } from "../../db.js";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { eventActorType, type ActorCtx } from "../../types.js";
import { sha256Hex } from "../../utils.js";
import { lineAlign, quoteAt, type Span } from "./similarity.js";
import { moveAnchors, NO_POSITION, type AnchorState, type MovedHow } from "./mapping.js";
import { verifiedEditorChanges, type EditorBodyChange } from "./changes.js";
import { enqueueAnchorRecovery } from "./recoverIntent.js";
import type { AnchorStatus } from "@onden/contract";

type AnchorRow = {
  anchor_id: string; note_id: string; from_utf16: number; to_utf16: number; at_body_hash: string;
  quote: string; quote_prefix: string; quote_suffix: string; status: AnchorStatus;
  candidate_from_utf16: number | null; candidate_to_utf16: number | null; recovery_pending: boolean;
};

const COLUMNS = `anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote, quote_prefix, quote_suffix,
  status, candidate_from_utf16, candidate_to_utf16, recovery_pending`;

function toState(r: AnchorRow): AnchorState {
  return {
    anchorId: r.anchor_id,
    span: { from: r.from_utf16, to: r.to_utf16 },
    quote: { text: r.quote, prefix: r.quote_prefix, suffix: r.quote_suffix },
    status: r.status,
    candidate: r.candidate_from_utf16 === null || r.candidate_to_utf16 === null
      ? null : { from: r.candidate_from_utf16, to: r.candidate_to_utf16 },
    recoveryPending: r.recovery_pending,
  };
}

export type StoredAnchor = AnchorState & { noteId: string; atBodyHash: string };

/** Every anchor of a note, oldest id first. */
export async function listNoteAnchors(workspaceId: string, noteId: string): Promise<StoredAnchor[]> {
  const r = await q<AnchorRow>(
    `SELECT ${COLUMNS} FROM block_anchors WHERE workspace_id = $1 AND note_id = $2 ORDER BY created_at, anchor_id`,
    [workspaceId, noteId],
  );
  return r.rows.map((row) => ({ ...toState(row), noteId: row.note_id, atBodyHash: row.at_body_hash }));
}

/** An anchor that a body write puts on a block of the note's own text: a paragraph that comes back into the note
 *  (收回原文; kind "return": the anchor exists, in the child note) or a block whose id is already promised (a task
 *  line, an AI reply, an imported `^id`; kind "new": the anchor is made, and left alone if the id is taken). Kind "carry":
 *  the block moved here with its text (搬成子筆記 of a selection or section): the anchor exists in the note it left, and its
 *  block row, schedule and tags come along — one identity, new place.
 *  `text` is the block's text in the saved body; `at` where it starts, when the caller knows. */
export type AdoptAnchor = { anchorId: string; text: string; at?: number; kind: "new" | "return" | "carry" };

/** Puts each of `adopts` on its block in `markdown` (the note's saved body). A text that stands nowhere, or twice
 *  with no `at`, is skipped: the block then gets an anchor of its own like any other, never a guess. Returns the ids
 *  that were not placed. Call in the transaction that wrote the body. */
export async function adoptAnchorsInto(
  workspaceId: string, noteId: string, markdown: string, adopts: readonly AdoptAnchor[],
  cause: { actor: ActorCtx; eventId?: string },
): Promise<string[]> {
  const left: string[] = [];
  for (const adopt of adopts) {
    const known = adopt.at !== undefined && markdown.startsWith(adopt.text, adopt.at) ? adopt.at : -1;
    const found = markdown.indexOf(adopt.text);
    const at = known !== -1 ? known : found !== -1 && markdown.indexOf(adopt.text, found + 1) === -1 ? found : -1;
    if (at === -1) { left.push(adopt.anchorId); continue; }
    const span = { from: at, to: at + adopt.text.length };
    if (adopt.kind === "return" || adopt.kind === "carry") {
      if (!(await rehomeAnchor(workspaceId, adopt.anchorId, noteId, markdown, span))) { left.push(adopt.anchorId); continue; }
      // The row follows its anchor; its parent (a block of the note it left) is read again by the note's block sync.
      if (adopt.kind === "carry") await carryBlockRow(workspaceId, adopt.anchorId, noteId);
      continue;
    }
    if ((await anchorHolderNote(workspaceId, adopt.anchorId)) !== null) { left.push(adopt.anchorId); continue; }
    await insertAnchor(workspaceId, noteId, markdown, span, cause, adopt.anchorId);
  }
  return left;
}

/**
 * Anchors that left with a paragraph into a child note of `noteId` which is in the trash now come back when the
 * note's text has that paragraph again — the edit that moved it out was undone (the restore puts the text back; the
 * child is trashed with it). The anchor and its row (task, schedule, tags) return to the block whose text is exactly
 * the anchor's quote (or the row's text from before it left). A text that stands twice, or two anchors with the same text, is left alone: the blocks then get
 * anchors of their own, never a guess. Call in the transaction that wrote `markdown`, before the block rows are read.
 * Returns how many came back.
 */
export async function takeBackStrandedAnchors(workspaceId: string, noteId: string, markdown: string): Promise<number> {
  // The text each stands for: its quote in the child, and the row's text as it was written here (a paragraph's own
  // `{tags}` left it for the child's tags).
  const stranded = await db.selectFrom("block_anchors as a")
    .innerJoin("content_nodes as c", (join) => join.onRef("c.workspace_id", "=", "a.workspace_id").onRef("c.id", "=", "a.note_id"))
    .leftJoin("block_nodes as bn", (join) => join.onRef("bn.workspace_id", "=", "a.workspace_id").onRef("bn.anchor_id", "=", "a.anchor_id"))
    .select(["a.anchor_id", "a.quote", "bn.text_cache"])
    .where("c.workspace_id", "=", workspaceId).where("c.parent_id", "=", noteId).where("c.deleted_at", "is not", null).where("a.status", "=", "valid")
    .execute();
  if (stranded.length === 0) return 0;
  const startOf = (from: number) => { let at = from; while (at < markdown.length && (markdown[at] === " " || markdown[at] === "\t")) at++; return at; };
  const taken = new Set((await listNoteAnchors(workspaceId, noteId)).filter((a) => a.status === "valid").map((a) => startOf(a.span.from)));
  const free = blockSpans(markdown).filter((s) => !taken.has(s.start)).map((s) => ({ from: s.start, to: s.end, kind: s.kind }));
  let back = 0;
  const textsOf = (a: { quote: string; text_cache: string | null }) => [a.quote, ...(a.text_cache ? [a.text_cache] : [])];
  for (const anchor of stranded) {
    const texts = textsOf(anchor);
    if (stranded.filter((o) => textsOf(o).some((t) => texts.includes(t))).length !== 1) continue;
    const spots = free.filter((s) => texts.includes(markdown.slice(s.from, s.to)));
    if (spots.length !== 1) continue;
    if (!(await rehomeAnchor(workspaceId, anchor.anchor_id, noteId, markdown, spots[0]!))) continue;
    await carryBlockRow(workspaceId, anchor.anchor_id, noteId);
    free.splice(free.indexOf(spots[0]!), 1);
    back++;
  }
  return back;
}

/** Where each of `anchorIds` is now, by id, in whichever note of the workspace holds it. */
export async function anchorsByIds(workspaceId: string, anchorIds: readonly string[]): Promise<Map<string, {
  noteId: string; from: number; to: number; status: AnchorStatus; candidate: { from: number; to: number } | null; quote: string;
}>> {
  if (anchorIds.length === 0) return new Map();
  const rows = await db.selectFrom("block_anchors")
    .select(["anchor_id", "note_id", "from_utf16", "to_utf16", "status", "candidate_from_utf16", "candidate_to_utf16", "quote"])
    .where("workspace_id", "=", workspaceId).where("anchor_id", "in", [...anchorIds]).execute();
  return new Map(rows.map((r) => [r.anchor_id, {
    noteId: r.note_id, from: r.from_utf16, to: r.to_utf16, status: r.status as AnchorStatus, quote: r.quote,
    candidate: r.candidate_from_utf16 === null || r.candidate_to_utf16 === null ? null : { from: r.candidate_from_utf16, to: r.candidate_to_utf16 },
  }]));
}

/** An excerpt (a quote with its source line, @onden/markdown excerpt.ts) is known by identity from the moment it is
 *  written: each excerpt-shaped quote block of `markdown` that no anchor starts at — and none points at as its likely
 *  place — gets one. Call in the transaction that wrote the body, after the note's anchors moved. Returns how many. */
export async function anchorExcerpts(workspaceId: string, noteId: string, markdown: string, cause: { actor: ActorCtx; eventId?: string }): Promise<number> {
  const spans = excerptBlockSpans(markdown);
  if (spans.length === 0) return 0;
  const indent = (from: number) => { let at = from; while (at < markdown.length && (markdown[at] === " " || markdown[at] === "\t")) at++; return at; };
  const stored = await listNoteAnchors(workspaceId, noteId);
  const covered = new Set(stored.flatMap((a) => (a.status === "valid" ? [indent(a.span.from)] : a.candidate ? [indent(a.candidate.from)] : [])));
  let made = 0;
  for (const span of spans) {
    if (covered.has(indent(span.from))) continue;
    await insertAnchor(workspaceId, noteId, markdown, span, cause);
    made++;
  }
  return made;
}

/** The block of `anchorId` was taken out of `noteId` on purpose (a task's line leaving its note): the anchor is `lost`
 *  with no guess, never a "maybe here" at a paragraph that happens to read alike. Its id stays taken. Call in the
 *  transaction that wrote the body. */
export async function retireAnchor(workspaceId: string, noteId: string, anchorId: string): Promise<void> {
  await db.updateTable("block_anchors").set({
    status: "lost", from_utf16: NO_POSITION.from, to_utf16: NO_POSITION.to,
    candidate_from_utf16: null, candidate_to_utf16: null, recovery_pending: false, moved_at: sql`now()`,
  }).where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).where("anchor_id", "=", anchorId).execute();
}

/** The block row of anchor `anchorId` stands in `noteId` now (its id, schedule and tags are the row's, so they come along). */
export async function carryBlockRow(workspaceId: string, anchorId: string, noteId: string): Promise<void> {
  await db.updateTable("block_nodes").set({ note_id: noteId, parent_block_id: null, detached_note_id: null, detached_tags: null, updated_at: sql`now()` })
    .where("workspace_id", "=", workspaceId).where("anchor_id", "=", anchorId).execute();
}

/** The valid anchors of a note as the parser and the text rules take them (id, where its block starts and ends). */
export async function noteAnchorRanges(workspaceId: string, noteId: string): Promise<Array<{ id: string; from: number; to: number }>> {
  return (await listNoteAnchors(workspaceId, noteId)).filter((a) => a.status === "valid")
    .map((a) => ({ id: a.anchorId, from: a.span.from, to: a.span.to }));
}

/** `markdown`'s blocks, each with the id of the anchor that starts it (what a block's `ref` is). `markdown` is the
 *  note's current body: the anchors were measured on it. */
export async function parseNoteBlocks(workspaceId: string, noteId: string, markdown: string): Promise<ParsedBlock[]> {
  return parseBlocks(markdown, await noteAnchorRanges(workspaceId, noteId));
}

/** An anchor id no anchor of the workspace has (ids are never reused, lost ones included). */
export async function freeAnchorId(workspaceId: string): Promise<string> {
  for (;;) {
    const id = newBlockId();
    if ((await anchorHolderNote(workspaceId, id)) === null) return id;
  }
}

/** The note that holds anchor `anchorId` (any status), or null when no anchor has it. */
export async function anchorHolderNote(workspaceId: string, anchorId: string): Promise<string | null> {
  const row = await db.selectFrom("block_anchors").select("note_id")
    .where("workspace_id", "=", workspaceId).where("anchor_id", "=", anchorId).executeTakeFirst();
  return row?.note_id ?? null;
}

/** The notes (ids) that hold any of the valid anchors `anchorIds`. */
export async function noteIdsHoldingAnchors(workspaceId: string, anchorIds: readonly string[]): Promise<string[]> {
  if (anchorIds.length === 0) return [];
  const rows = await db.selectFrom("block_anchors").select("note_id").distinct()
    .where("workspace_id", "=", workspaceId).where("anchor_id", "in", [...anchorIds]).where("status", "=", "valid").execute();
  return rows.map((r) => r.note_id);
}

/** Whether `noteId` holds a valid anchor `anchorId`: the note has that block. */
export async function noteHoldsAnchor(workspaceId: string, noteId: string, anchorId: string): Promise<boolean> {
  const row = await db.selectFrom("block_anchors").select("anchor_id")
    .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).where("anchor_id", "=", anchorId).where("status", "=", "valid")
    .executeTakeFirst();
  return row !== undefined;
}

/** The valid anchors of several notes as the text rules take them, keyed by note. */
export async function validAnchorRangesByNote(workspaceId: string, noteIds: readonly string[]): Promise<Map<string, Array<{ id: string; from: number; to: number }>>> {
  const out = new Map<string, Array<{ id: string; from: number; to: number }>>();
  if (noteIds.length === 0) return out;
  const rows = await db.selectFrom("block_anchors").select(["note_id", "anchor_id", "from_utf16", "to_utf16"])
    .where("workspace_id", "=", workspaceId).where("note_id", "in", [...noteIds]).where("status", "=", "valid")
    .orderBy("created_at").orderBy("anchor_id").execute();
  for (const a of rows) {
    const list = out.get(a.note_id) ?? [];
    list.push({ id: a.anchor_id, from: a.from_utf16, to: a.to_utf16 });
    out.set(a.note_id, list);
  }
  return out;
}

/** Anchor `from` becomes `to` (the id a block row was already known by): the anchor, and the link bindings that name it,
 *  follow. Only an anchor of `noteId`; false when it is not there or `to` is taken. */
export async function renameAnchor(workspaceId: string, noteId: string, from: string, to: string): Promise<boolean> {
  if ((await anchorHolderNote(workspaceId, to)) !== null) return false;
  const done = await db.updateTable("block_anchors").set({ anchor_id: to })
    .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).where("anchor_id", "=", from).executeTakeFirst();
  if (Number(done.numUpdatedRows) === 0) return false;
  await db.updateTable("block_link_bindings").set({ anchor_id: to }).where("workspace_id", "=", workspaceId).where("anchor_id", "=", from).execute();
  return true;
}

/**
 * Anchors the block at `at` (any offset inside it) of `markdown`, the note's current body.
 * Returns the existing anchor id when that block already has one. Call inside the transaction that
 * holds the note's body fixed (the body hash it records must be the committed one). A new anchor is
 * recorded as BLOCK_ANCHOR_CREATED, attributed to `cause.actor` (whose operation made it).
 */
export async function ensureBlockAnchor(
  workspaceId: string, noteId: string, markdown: string, at: number,
  cause: { actor: ActorCtx; eventId?: string; device?: string | null },
): Promise<string | null> {
  const span = partSpanAt(markdown, at);
  if (span === null) return null;
  const existing = (await listNoteAnchors(workspaceId, noteId)).find(
    (a) => a.status === "valid" && a.span.from === span.from && a.span.to === span.to,
  );
  if (existing) return existing.anchorId;
  return insertAnchor(workspaceId, noteId, markdown, span, cause);
}

/** Records a new anchor for `span` of `markdown` (the note's committed body). An id is never reused, lost
 *  ones included: the primary key refuses a taken one and we draw again. */
export async function insertAnchor(
  workspaceId: string, noteId: string, markdown: string, span: Span,
  cause: { actor: ActorCtx; eventId?: string; device?: string | null },
  /** An id the caller already told others about (a task placed as a line knows its block before the note is saved):
   *  taken as it is, and refused when another anchor has it. */
  fixedId?: string,
): Promise<string> {
  const hash = sha256Hex(markdown);
  const quote = quoteAt(markdown, span);
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = fixedId ?? newBlockId();
    const r = await q(
      `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote, quote_prefix, quote_suffix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [workspaceId, id, noteId, span.from, span.to, hash, quote.text, quote.prefix, quote.suffix],
    );
    if (r.rowCount === 1) {
      await recordAnchorEvent(workspaceId, noteId, ANCHOR_EVENTS.created, id, cause,
        { parentVersion: hash, device: cause.device ?? null, how: "created" });
      return id;
    }
    if (fixedId) throw new Error("anchor id already in use");
  }
  throw new Error("could not draw a free anchor id");
}

/**
 * Puts an existing anchor on `span` of `noteId`'s body `markdown` as a valid one: a paragraph that became its
 * own note (or came back) keeps its anchor id, so links to it do not change. Call in the transaction that
 * wrote `markdown`. Returns false when the anchor does not exist.
 */
export async function rehomeAnchor(workspaceId: string, anchorId: string, noteId: string, markdown: string, span: Span): Promise<boolean> {
  const quote = quoteAt(markdown, span);
  const r = await db.updateTable("block_anchors").set({
    note_id: noteId, from_utf16: span.from, to_utf16: span.to, at_body_hash: sha256Hex(markdown), quote: quote.text,
    quote_prefix: quote.prefix, quote_suffix: quote.suffix, status: "valid", candidate_from_utf16: null, candidate_to_utf16: null,
    recovery_pending: false, moved_how: "confirmed", moved_at: sql`now()`,
  }).where("workspace_id", "=", workspaceId).where("anchor_id", "=", anchorId).executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/**
 * The person confirms where a `maybe` (or a `lost` with a best guess) anchor is: its candidate becomes its place.
 * Call inside the transaction that holds the note's body fixed. Returns false when there is nothing to confirm
 * (already valid, no candidate, or the candidate no longer fits the text), in which case nothing is written.
 */
export async function confirmAnchorCandidate(
  workspaceId: string, noteId: string, anchorId: string, markdown: string,
  cause: { actor: ActorCtx },
): Promise<boolean> {
  const row = (await q<AnchorRow>(
    `SELECT ${COLUMNS} FROM block_anchors WHERE workspace_id = $1 AND note_id = $2 AND anchor_id = $3 FOR UPDATE`,
    [workspaceId, noteId, anchorId],
  )).rows[0];
  if (!row || row.status === "valid" || row.candidate_from_utf16 === null || row.candidate_to_utf16 === null) return false;
  const span = lineAlign(markdown, { from: row.candidate_from_utf16, to: row.candidate_to_utf16 });
  if (span.from < 0 || span.to > markdown.length || span.from >= span.to) return false;
  const quote = quoteAt(markdown, span);
  const hash = sha256Hex(markdown);
  await q(
    `UPDATE block_anchors SET from_utf16 = $4, to_utf16 = $5, at_body_hash = $6, quote = $7, quote_prefix = $8, quote_suffix = $9,
            status = 'valid', candidate_from_utf16 = NULL, candidate_to_utf16 = NULL, recovery_pending = false,
            moved_how = 'confirmed', moved_at = now()
      WHERE workspace_id = $1 AND note_id = $2 AND anchor_id = $3`,
    [workspaceId, noteId, anchorId, span.from, span.to, hash, quote.text, quote.prefix, quote.suffix],
  );
  await recordAnchorEvent(workspaceId, noteId, ANCHOR_EVENTS.confirmed, anchorId, cause,
    { parentVersion: hash, device: null, how: "confirmed" });
  return true;
}

/** The lines of the paragraph (run of non-blank lines) around `at`; null on a blank line. */
export function blockSpanAt(markdown: string, at: number): Span | null {
  if (at < 0 || at > markdown.length) return null;
  const lineStart = markdown.lastIndexOf("\n", at - 1) + 1;
  let lineEnd = markdown.indexOf("\n", at);
  if (lineEnd < 0) lineEnd = markdown.length;
  if (markdown.slice(lineStart, lineEnd).trim() === "") return null;
  let from = lineStart;
  while (from > 0) {
    const prevStart = markdown.lastIndexOf("\n", from - 2) + 1;
    if (markdown.slice(prevStart, from - 1).trim() === "") break;
    from = prevStart;
  }
  let to = lineEnd;
  while (to < markdown.length) {
    let next = markdown.indexOf("\n", to + 1);
    if (next < 0) next = markdown.length;
    if (markdown.slice(to + 1, next).trim() === "") break;
    to = next;
  }
  return lineAlign(markdown, { from, to });
}

const HEADING_LINE = /^ {0,3}#{1,6}[ \t]/;
const LIST_ITEM_LINE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/**
 * The part of a note a link means at `at`: a heading is its one line, a list item is that item (its own lines and
 * the ones nested under it, not the whole list), anything else the paragraph around it (`blockSpanAt`).
 * Null on a blank line.
 */
export function partSpanAt(markdown: string, at: number): Span | null {
  const para = blockSpanAt(markdown, at);
  if (para === null) return null;
  const lines: Array<{ from: number; to: number; text: string }> = [];
  for (let from = para.from; from <= para.to;) {
    let to = markdown.indexOf("\n", from);
    if (to < 0 || to > para.to) to = para.to;
    lines.push({ from, to, text: markdown.slice(from, to) });
    from = to + 1;
  }
  const i = lines.findIndex((l) => at >= l.from && at <= l.to);
  const here = lines[i < 0 ? 0 : i]!;
  if (HEADING_LINE.test(here.text)) return lineAlign(markdown, { from: here.from, to: here.to });
  // A list item: back to the line that opens it, forward over deeper lines.
  let start = i < 0 ? 0 : i;
  while (start > 0 && !LIST_ITEM_LINE.test(lines[start]!.text)) start--;
  const open = LIST_ITEM_LINE.exec(lines[start]!.text);
  if (!open) return para;
  const indent = open[1]!.length;
  let end = start;
  while (end + 1 < lines.length) {
    const next = LIST_ITEM_LINE.exec(lines[end + 1]!.text);
    if (next && next[1]!.length <= indent) break;
    end++;
  }
  return lineAlign(markdown, { from: lines[start]!.from, to: lines[end]!.to });
}

export type BodyMove = {
  workspaceId: string;
  noteId: string;
  /** The body the write replaced; null when the caller does not have it (anchors are then found by their quote). */
  before: string | null;
  after: string;
  /** The editor's CodeMirror ChangeSet (toJSON) and device, unverified. */
  bodyChange?: EditorBodyChange;
  /** The body event this move belongs to and who made it: anchors that change state are recorded as events
   *  caused by it (ANCHOR_EVENTS). Without it nothing is recorded. */
  cause?: { actor: ActorCtx; eventId: string };
};

/**
 * Anchor events: one per anchor whose state changes (not per move — a typed character moves every anchor).
 * Target is the note, like block-node events, so exactly the note's readers see them; they carry no
 * `body_hash`, so no History page counts them as a save, and nothing here touches the note's `updated_at`
 * ("recently edited" stays the user's edits). Payload: the anchor, the version it was measured on
 * (`parent_version`: body hash before), the device and the body event that caused it. They are not chained
 * to that event (triggered_by), so undoing the edit neither lists nor undoes them: the restore moves the
 * anchors itself. The event log's list leaves them out (services/eventQuery.ts).
 */
export const ANCHOR_EVENTS = {
  created: "BLOCK_ANCHOR_CREATED",
  confirmed: "BLOCK_ANCHOR_CONFIRMED",
  maybe: "BLOCK_ANCHOR_MAYBE",
  lost: "BLOCK_ANCHOR_LOST",
  /** A part link was written in this note and bound to an anchor (services/blockLinks.ts). Targets the note the link is in,
   *  so the sync re-ships that note's bindings. */
  linked: "BLOCK_ANCHOR_LINKED",
} as const;
export type AnchorEventType = (typeof ANCHOR_EVENTS)[keyof typeof ANCHOR_EVENTS];

/** The event for an anchor going from `from` to `to`, or null when the change is not worth recording. */
export function anchorEventFor(from: AnchorStatus, to: AnchorStatus): AnchorEventType | null {
  if (from === to) return null;
  if (to === "valid") return ANCHOR_EVENTS.confirmed;
  return to === "maybe" ? ANCHOR_EVENTS.maybe : ANCHOR_EVENTS.lost;
}

export async function recordAnchorEvent(
  workspaceId: string, noteId: string, type: AnchorEventType, anchorId: string,
  cause: { actor: ActorCtx; eventId?: string }, detail: { parentVersion: string | null; device: string | null; how: string },
): Promise<void> {
  await event(
    workspaceId, type, "node", noteId,
    { anchor_id: anchorId, parent_version: detail.parentVersion, device: detail.device, how: detail.how, body_event_id: cause.eventId ?? null },
    // Not `triggeredBy` the body event: that would list them as things undoing the edit also undoes.
    eventActorType(cause.actor.type), cause.actor.id,
  );
}

/** Records that a part link written in `sourceNoteId` was bound to `anchorId` (an anchor of `targetNoteId`). */
export async function recordLinkBound(
  workspaceId: string, sourceNoteId: string, anchorId: string, targetNoteId: string, actor: ActorCtx,
): Promise<void> {
  await event(workspaceId, ANCHOR_EVENTS.linked, "node", sourceNoteId, { anchor_id: anchorId, target_note_id: targetNoteId },
    eventActorType(actor.type), actor.id);
}

export type BodyMoveSummary = { moved: number; valid: number; maybe: number; lost: number; /** left for the background pass (over the per-save find budget) */ pending: number; how: Record<MovedHow, number> };

/** Moves the note's anchors from `before` to `after`. Idempotent for a given pair of texts. */
export async function moveAnchorsForBodyChange(move: BodyMove): Promise<BodyMoveSummary> {
  const { workspaceId, noteId, before, after } = move;
  const rows = await q<AnchorRow>(
    `SELECT ${COLUMNS} FROM block_anchors WHERE workspace_id = $1 AND note_id = $2 FOR UPDATE`,
    [workspaceId, noteId],
  );
  const summary: BodyMoveSummary = { moved: 0, valid: 0, maybe: 0, lost: 0, pending: 0, how: { editor: 0, diff: 0, found: 0, unchanged: 0 } };
  if (rows.rows.length === 0) return summary;

  const beforeHash = before === null ? null : sha256Hex(before);
  const hashOf = new Map(rows.rows.map((r) => [r.anchor_id, r.at_body_hash]));
  const editorChanges = before !== null && move.bodyChange !== undefined
    ? verifiedEditorChanges(move.bodyChange.changes, before, after) : null;
  const afterHash = sha256Hex(after);
  const moved = moveAnchors(rows.rows.map(toState), {
    before, after, editorChanges,
    trusted: (id) => beforeHash !== null && hashOf.get(id) === beforeHash,
    settled: (id) => hashOf.get(id) === afterHash,
  });

  const statusBefore = new Map(rows.rows.map((r) => [r.anchor_id, r.status]));
  const changed = moved.filter((m) => m.changed);
  for (const m of moved) {
    summary.how[m.how]++;
    summary[m.status]++;
    if (m.recoveryPending) summary.pending++;
    if (m.changed) summary.moved++;
  }
  // One statement for every anchor of the note: the ones that moved or changed state take their new place, the rest only learn the new body hash. A save costs one
  // query however many anchors the note has, and the note's anchors unit (migration 215, written after each statement that writes anchors) is written once.
  if (moved.length > 0) {
    await q(
      `UPDATE block_anchors a SET at_body_hash = $3,
              from_utf16 = CASE WHEN v.changed THEN v.from_utf16 ELSE a.from_utf16 END, to_utf16 = CASE WHEN v.changed THEN v.to_utf16 ELSE a.to_utf16 END,
              quote = CASE WHEN v.changed THEN v.quote ELSE a.quote END, quote_prefix = CASE WHEN v.changed THEN v.quote_prefix ELSE a.quote_prefix END,
              quote_suffix = CASE WHEN v.changed THEN v.quote_suffix ELSE a.quote_suffix END, status = CASE WHEN v.changed THEN v.status ELSE a.status END,
              candidate_from_utf16 = CASE WHEN v.changed THEN v.candidate_from ELSE a.candidate_from_utf16 END,
              candidate_to_utf16 = CASE WHEN v.changed THEN v.candidate_to ELSE a.candidate_to_utf16 END,
              recovery_pending = CASE WHEN v.changed THEN v.recovery_pending ELSE a.recovery_pending END,
              moved_how = CASE WHEN v.changed THEN v.moved_how ELSE a.moved_how END, moved_at = CASE WHEN v.changed THEN now() ELSE a.moved_at END
         FROM unnest($4::text[], $5::int[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[], $11::int[], $12::int[], $13::boolean[], $14::text[], $15::boolean[])
              AS v(anchor_id, from_utf16, to_utf16, quote, quote_prefix, quote_suffix, status, candidate_from, candidate_to, recovery_pending, moved_how, changed)
        WHERE a.workspace_id = $1 AND a.note_id = $2 AND a.anchor_id = v.anchor_id`,
      [workspaceId, noteId, afterHash,
        moved.map((m) => m.anchorId), moved.map((m) => m.span.from), moved.map((m) => m.span.to),
        moved.map((m) => m.quote.text), moved.map((m) => m.quote.prefix), moved.map((m) => m.quote.suffix),
        moved.map((m) => m.status), moved.map((m) => m.candidate?.from ?? null), moved.map((m) => m.candidate?.to ?? null),
        moved.map((m) => m.recoveryPending), moved.map((m) => m.how), moved.map((m) => m.changed)],
    );
  }
  if (move.cause) {
    for (const m of moved) {
      const type = anchorEventFor(statusBefore.get(m.anchorId) ?? m.status, m.status);
      if (type) {
        await recordAnchorEvent(workspaceId, noteId, type, m.anchorId, move.cause,
          { parentVersion: beforeHash, device: move.bodyChange?.device ?? null, how: m.how });
      }
    }
  }
  // Over the per-save find budget: the rest is looked up in the background (recover.ts), not by whichever save comes next.
  if (summary.pending > 0) await enqueueAnchorRecovery(workspaceId, noteId, move.cause?.eventId);
  return summary;
}

/** What a client needs of an anchor: where it is and whether it can be trusted. */
export type AnchorWireRow = {
  anchor_id: string; note_id: string; from: number; to: number;
  status: AnchorStatus; candidate_from: number | null; candidate_to: number | null;
  /** What the paragraph said when last confirmed, cut to ANCHOR_QUOTE_WIRE_MAX: the words a link shows when the paragraph is gone or not here. */
  quote: string;
};

export const ANCHOR_QUOTE_WIRE_MAX = 120;

/**
 * The anchors of `noteIds`, for the bootstrap and the sync delta. The caller passes only notes the
 * reader may read (the same scope as the note rows it ships); a note's anchors ship whole, so the
 * client replaces what it holds for those notes.
 */
export async function anchorRowsForNotes(workspaceId: string, noteIds: string[]): Promise<AnchorWireRow[]> {
  if (noteIds.length === 0) return [];
  const r = await q<AnchorRow>(
    `SELECT ${COLUMNS} FROM block_anchors WHERE workspace_id = $1 AND note_id = ANY($2::uuid[]) ORDER BY note_id, from_utf16`,
    [workspaceId, noteIds],
  );
  return r.rows.map((a) => ({
    anchor_id: a.anchor_id, note_id: a.note_id, from: a.from_utf16, to: a.to_utf16, status: a.status,
    candidate_from: a.candidate_from_utf16, candidate_to: a.candidate_to_utf16,
    quote: cutToUnits(a.quote, ANCHOR_QUOTE_WIRE_MAX),
  }));
}

/** An anchor as the backup file keeps it: text positions only; the quote is re-read from the text on restore. */
export type AnchorBackupRow = { id: string; from: number; to: number };

/** The trusted anchors of each of `noteIds` for a backup, in one query (a note without any has no entry). Anchors that
 *  are not sure where they are stay out. */
export async function anchorBackupRowsByNote(workspaceId: string, noteIds: string[]): Promise<Map<string, AnchorBackupRow[]>> {
  const byNote = new Map<string, AnchorBackupRow[]>();
  if (noteIds.length === 0) return byNote;
  const r = await q<{ note_id: string; anchor_id: string; from_utf16: number; to_utf16: number }>(
    `SELECT note_id::text, anchor_id, from_utf16, to_utf16 FROM block_anchors
      WHERE workspace_id = $1 AND note_id = ANY($2::uuid[]) AND status = 'valid' ORDER BY note_id, from_utf16, anchor_id`,
    [workspaceId, noteIds],
  );
  for (const a of r.rows) {
    const row = { id: a.anchor_id, from: a.from_utf16, to: a.to_utf16 };
    const list = byNote.get(a.note_id);
    if (list) list.push(row); else byNote.set(a.note_id, [row]);
  }
  return byNote;
}

/**
 * Puts a backup's anchors back on a restored note whose body is `markdown`. An anchor whose id is
 * already taken in this workspace (ids are never reused) or whose span no longer fits the text is
 * skipped; returns how many were restored.
 */
export async function restoreBackupAnchors(
  workspaceId: string, noteId: string, markdown: string, rows: readonly AnchorBackupRow[],
): Promise<number> {
  const hash = sha256Hex(markdown);
  let restored = 0;
  for (const a of rows) {
    if (!(a.from >= 0 && a.from < a.to && a.to <= markdown.length)) continue;
    const quote = quoteAt(markdown, { from: a.from, to: a.to });
    const r = await q(
      `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote, quote_prefix, quote_suffix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [workspaceId, a.id, noteId, a.from, a.to, hash, quote.text, quote.prefix, quote.suffix],
    );
    restored += r.rowCount ?? 0;
  }
  return restored;
}

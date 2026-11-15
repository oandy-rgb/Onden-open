// `[[筆記/段落開頭]]` on the server: making the link (an anchor on the paragraph and the binding that says
// "this link text means that anchor"), confirming a doubtful anchor, and what the sync, a backup and the
// delete warning need to know about the bindings. docs/architecture/proposals/block-anchors-2026-11-01.md §0.5, §6, §7.
//
// The words of a link and their reading are @onden/markdown blockLink.ts; this file only keeps the table
// `block_link_bindings` beside the text. A binding belongs to the note the link is written in (it is written
// and read with that note) and names an anchor of the target note.

import { cutToGraphemes, bindingKey, blockExcerptOf, blockLinkText, listLinkTargets, scanWikilinks, splitWikilink, plainExcerpt, normalizeText } from "@onden/markdown";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { assertAuthority, AuthorityError } from "../spine/authority.js";
import { ScopeError } from "../spine/toolScope.js";
import { canReadNode, readableScopeSql } from "./readPolicy.js";
import { confirmAnchorCandidate, ensureBlockAnchor, listNoteAnchors, partSpanAt, recordLinkBound } from "./blockAnchors/index.js";
import { StatusError } from "../statusError.js";
import { liveNodeSql } from "../spine/nodeSql.js";
import { isNote } from "@onden/markdown/contract";

/** A refusal with nothing written. The client does not branch on it (`bind` is best effort and swallows it; a
 *  confirmation shows the generic failure notice), so it carries a plain English reason, not a code. */
export class BlockLinkError extends StatusError {}

type NoteRow = { id: string; title: string; markdown: string; node_type: string };

async function loadNote(workspaceId: string, id: string): Promise<NoteRow | null> {
  return (await q<NoteRow>(
    `SELECT id::text, title, markdown, node_type FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()} FOR UPDATE`,
    [workspaceId, id],
  )).rows[0] ?? null;
}

const canWrite = async (actor: ActorCtx, nodeId: string): Promise<boolean> => {
  try { await assertAuthority(actor, { kind: "node", nodeId, op: "write_node" }); return true; }
  catch (e) { if (e instanceof AuthorityError || e instanceof ScopeError) return false; throw e; }
};

const fold = (s: string) => normalizeText(s).replace(/\s+/g, " ").trim().toLowerCase();

/** Where the part the person saw is now: at `at` when its words still start the same way, else the one part whose words do. */
function locatePart(markdown: string, at: number, seenText: string): number | null {
  const wanted = fold(plainExcerpt(seenText, 20));
  const span = partSpanAt(markdown, Math.min(Math.max(at, 0), markdown.length));
  if (span && wanted && fold(blockExcerptOf(markdown.slice(span.from, span.to))).startsWith(wanted.replace(/…$/, ""))) return span.from;
  const hits = listLinkTargets(markdown).filter((t) => fold(t.text).startsWith(cutToGraphemes(fold(seenText), 20)));
  return hits.length === 1 ? hits[0]!.start : null;
}

export type CreatedBlockLink = {
  anchorId: string;
  /** What goes between `[[` and `]]`: `筆記/開頭`, or `/開頭` when the link is written in the target note itself. */
  link: string;
  /** The words after the `/` (made unique within the note the link is written in). */
  linkText: string;
};

/**
 * Links a part of `targetNoteId` from `sourceNoteId`: anchors the part (the existing anchor when it has one) and
 * binds the link as it will be written. One transaction, so a link never exists without its anchor.
 *
 * `at`/`seenText` are where the person saw the part and what it began with; if the text changed under them the part
 * is looked up by its words, and a part that cannot be named is refused (409, “the part changed”) rather than guessed.
 * Anchoring a part of a note the actor may only read is refused (409): the caller links the whole
 * note instead. Reading it is enough when the part already has a valid anchor.
 */
export async function createBlockLink(input: {
  workspaceId: string; actor: ActorCtx; targetNoteId: string; sourceNoteId: string;
  at: number; seenText: string; suggestedText?: string;
}): Promise<CreatedBlockLink> {
  const { workspaceId, targetNoteId, sourceNoteId } = input;
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    const source = await loadNote(workspaceId, sourceNoteId);
    if (!source || !isNote(source)) throw new BlockLinkError(404, "source note");
    const target = targetNoteId === sourceNoteId ? source : await loadNote(workspaceId, targetNoteId);
    // A note the actor cannot read is answered like one that is not there, before anything else is said.
    if (!target || !isNote(target) || !await canReadNode(actor, targetNoteId)) throw new BlockLinkError(404, "target note");
    if (!await canWrite(actor, sourceNoteId)) throw new BlockLinkError(403, "the note the link is written in cannot be changed");

    const start = locatePart(target.markdown, input.at, input.seenText);
    if (start === null) throw new BlockLinkError(409, "the part changed");
    const existing = (await anchorOfPart(workspaceId, targetNoteId, target.markdown, start));
    if (!existing && !await canWrite(actor, targetNoteId)) throw new BlockLinkError(409, "the note cannot take a new anchor");
    const anchorId = existing ?? await ensureBlockAnchor(workspaceId, targetNoteId, target.markdown, start, { actor });
    if (!anchorId) throw new BlockLinkError(422, "nothing to link at that place");

    const words = blockLinkText(input.suggestedText ?? blockExcerptOf(target.markdown.slice(start)) ) || blockLinkText(target.title);
    const prefix = targetNoteId === sourceNoteId ? "" : target.title;
    let text = words;
    for (let n = 2; n < 50; n++) {
      const key = bindingKey(`${prefix}/${text}`);
      const taken = (await q<{ anchor_id: string }>(
        `SELECT anchor_id FROM block_link_bindings WHERE workspace_id = $1 AND note_id = $2 AND link_text = $3`, [workspaceId, sourceNoteId, key],
      )).rows[0];
      if (!taken) {
        await q(`INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1, $2, $3, $4)`, [workspaceId, sourceNoteId, key, anchorId]);
        break;
      }
      if (taken.anchor_id === anchorId) break;
      text = `${words} ${n}`;
    }
    await recordLinkBound(workspaceId, sourceNoteId, anchorId, targetNoteId, actor);
    return { anchorId, link: `${prefix}/${text}`, linkText: text };
  });
}

/** The valid anchor already on the part starting at `start`, if any. */
async function anchorOfPart(workspaceId: string, noteId: string, markdown: string, start: number): Promise<string | null> {
  const span = partSpanAt(markdown, start);
  if (!span) return null;
  return (await listNoteAnchors(workspaceId, noteId)).find((a) => a.status === "valid" && a.span.from === span.from && a.span.to === span.to)?.anchorId ?? null;
}

/**
 * Confirms a doubtful anchor ("可能在這裡" → "就是這段"). Needs the note to be changeable; anyone else only sees the preview.
 * Returns false when there is nothing to confirm any more (someone else already did, or the text moved on).
 */
export async function confirmBlockAnchor(input: { workspaceId: string; actor: ActorCtx; noteId: string; anchorId: string }): Promise<boolean> {
  const { workspaceId, noteId } = input;
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    const note = await loadNote(workspaceId, noteId);
    if (!note || !isNote(note) || !await canReadNode(actor, noteId)) throw new BlockLinkError(404, "note");
    if (!await canWrite(actor, noteId)) throw new BlockLinkError(403, "the note cannot be changed");
    return confirmAnchorCandidate(workspaceId, noteId, input.anchorId, note.markdown, { actor });
  });
}

/** One binding as the sync ships it: the note the link is written in, the link as written, the anchor it means. */
type BindingWireRow = { note_id: string; link_text: string; anchor_id: string };

/** The bindings of `noteIds` (notes the caller has already limited to what the reader may read), whole per note. */
export async function bindingRowsForNotes(workspaceId: string, noteIds: string[]): Promise<BindingWireRow[]> {
  if (noteIds.length === 0) return [];
  const r = await q<BindingWireRow>(
    `SELECT note_id::text, link_text, anchor_id FROM block_link_bindings WHERE workspace_id = $1 AND note_id = ANY($2::uuid[]) ORDER BY note_id, link_text`,
    [workspaceId, noteIds],
  );
  return r.rows;
}

export type BlockLinkCount = { anchor_id: string; links: number };

/**
 * How many links (in notes the reader can read) mean each anchor of `noteId`. Counted from the notes' text: a binding
 * whose link is no longer written anywhere does not count. The number behind "有 N 處連到這段".
 */
export async function countBlockLinks(actor: ActorCtx, workspaceId: string, noteId: string): Promise<BlockLinkCount[]> {
  const anchorIds = (await listNoteAnchors(workspaceId, noteId)).map((a) => a.anchorId);
  if (anchorIds.length === 0) return [];
  const params: unknown[] = [workspaceId, anchorIds];
  const scope = readableScopeSql(actor, "s", params);
  const rows = (await q<{ anchor_id: string; link_text: string; markdown: string }>(
    `SELECT b.anchor_id, b.link_text, s.markdown
       FROM block_link_bindings b JOIN content_nodes s ON s.id = b.note_id
      WHERE b.workspace_id = $1 AND b.anchor_id = ANY($2::text[]) AND ${liveNodeSql("s")} AND ${scope}
      LIMIT 2000`, params,
  )).rows;
  const counts = new Map<string, number>();
  const written = new Map<string, Set<string>>();
  for (const row of rows) {
    let keys = written.get(row.markdown);
    if (!keys) written.set(row.markdown, keys = new Set(scanWikilinks(row.markdown).map((m) => bindingKey(splitWikilink(m.body).target))));
    if (keys.has(row.link_text)) counts.set(row.anchor_id, (counts.get(row.anchor_id) ?? 0) + 1);
  }
  return [...counts].map(([anchor_id, links]) => ({ anchor_id, links }));
}


/** A note's bindings as the backup file keeps them (the anchors they name are in the same file's other notes). */
export type BindingBackupRow = { text: string; anchor: string };

export async function bindingBackupRowsByNote(workspaceId: string, noteIds: string[]): Promise<Map<string, BindingBackupRow[]>> {
  const byNote = new Map<string, BindingBackupRow[]>();
  for (const b of await bindingRowsForNotes(workspaceId, noteIds)) {
    const row = { text: b.link_text, anchor: b.anchor_id };
    const list = byNote.get(b.note_id);
    if (list) list.push(row); else byNote.set(b.note_id, [row]);
  }
  return byNote;
}

/** Puts a backup's bindings back on a restored note. An anchor that came back under another id (its id was taken) is not
 *  followed: that link is then read by its words, like one typed by hand. Returns how many were restored. */
export async function restoreBackupBindings(workspaceId: string, noteId: string, rows: readonly BindingBackupRow[]): Promise<number> {
  let restored = 0;
  for (const b of rows) {
    if (typeof b.text !== "string" || typeof b.anchor !== "string" || b.text.length === 0 || b.text.length > 400) continue;
    const r = await q(
      `INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [workspaceId, noteId, b.text, b.anchor],
    );
    restored += r.rowCount ?? 0;
  }
  return restored;
}

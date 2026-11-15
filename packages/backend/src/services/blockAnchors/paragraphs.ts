// 「本篇的段落」: the paragraphs of a note that are block nodes (a `{topic}` or a task on them), as the
// info panel lists them. A read model over block_nodes and block_anchors; it writes nothing.
//
//   here      the text is in the note (留在原處); the anchor is valid or still being looked up (maybe)
//   standing  the text is a note of its own (獨立出去): `noteId` is that note when the reader may open it
//   lost      the anchor could not be found again: the row and its data are kept, the panel offers
//             "reassign" (「找不到的段落」)
//
// Who may see it: the caller checks the reader may read `noteId`. A standing paragraph's own note is
// offered only to a reader who may read it (readableAmong) — otherwise it is listed without a link, as
// a paragraph of this note, so the list never says more than the readers of the child could see.
// Topics are the paragraph's own tags that the reader can see (readPolicy.canSeeTag via the tag's scope).

import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import type { ActorCtx } from "../../types.js";
import { readableAmong } from "../readPolicy.js";
import type { NoteParagraph } from "@onden/contract";

type Row = {
  id: string; parent_block_id: string | null; label: string; block_ref: string; detached_note_id: string | null;
  anchor_status: "valid" | "maybe" | "lost" | null; anchor_here: boolean | null; tag_ids: string[];
};

export async function listNoteParagraphs(actor: ActorCtx, workspaceId: string, noteId: string): Promise<NoteParagraph[]> {
  const rows = (await sql<Row>`SELECT b.id::text, b.parent_block_id::text, b.label, b.block_ref, b.detached_note_id::text,
            a.status AS anchor_status, (a.note_id = b.note_id) AS anchor_here,
            coalesce(array_agg(t.tag_id::text) FILTER (WHERE t.tag_id IS NOT NULL), '{}') AS tag_ids
       FROM block_nodes b
       LEFT JOIN block_anchors a ON a.workspace_id = b.workspace_id AND a.anchor_id = b.anchor_id
       LEFT JOIN block_node_tags t ON t.block_node_id = b.id
      WHERE b.workspace_id = ${workspaceId} AND b.note_id = ${noteId} AND b.hidden_at IS NULL
      GROUP BY b.id, a.status, a.note_id, a.from_utf16
      ORDER BY CASE WHEN a.note_id = b.note_id AND a.status = 'valid' THEN a.from_utf16 END NULLS LAST, b.created_at, b.id`.execute(db)).rows;
  if (rows.length === 0) return [];

  const standing = await readableAmong(actor, workspaceId, rows.flatMap((r) => (r.detached_note_id ? [r.detached_note_id] : [])));
  const tagIds = [...new Set(rows.flatMap((r) => r.tag_ids))];
  const titles = new Map<string, string>();
  if (tagIds.length > 0) {
    const visible = await readableAmong(actor, workspaceId, tagIds);
    const named = visible.size === 0 ? [] : await db.selectFrom("content_nodes").select(["id", "title"]).where("workspace_id", "=", workspaceId).where("id", "in", [...visible]).execute();
    for (const t of named) titles.set(t.id, t.title);
  }
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_block_id,
    label: r.label,
    topics: r.tag_ids.flatMap((id) => titles.get(id) ?? []),
    where: r.detached_note_id ? "standing" : r.anchor_status === "lost" && r.anchor_here ? "lost" : "here",
    noteId: r.detached_note_id && standing.has(r.detached_note_id) ? r.detached_note_id : null,
    anchorStatus: r.anchor_status,
    blockRef: r.block_ref,
  }));
}

// Who cites the paragraphs of a note: `[[Note#^id]]` and `![[Note#^id]]` in
// other notes (the 「被引用 N 次」 number beside a paragraph). Read from the
// notes' own text, as the parser reads it (@onden/markdown blockCitations), but
// only from the few notes the wikilink edges already say link to this one —
// never a scan of bodies. A citing note the reader cannot read is neither
// listed nor counted: the cut is in the query (readableScopeSql).

import { blockCitations } from "@onden/markdown";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { readableScopeSql } from "./readPolicy.js";
import { nodeAliasesSql } from "./wikilinkEdges.js";
import type { BlockCitationRow } from "@onden/contract";

/** More linking notes than this are not all read: the count is then a lower bound. */
const SOURCES_MAX = 200;

/** The citations of note `noteId`'s paragraphs the reader can see. `[]` when the
 *  note is missing or unreadable (the same answer as when nothing cites it). */
export async function listBlockCitations(actor: ActorCtx, workspaceId: string, noteId: string): Promise<BlockCitationRow[]> {
  const params: unknown[] = [workspaceId, noteId];
  const targetScope = readableScopeSql(actor, "t", params);
  const target = (await q<{ title: string; slug: string; aliases: string[] }>(
    `SELECT t.title, t.slug, ${nodeAliasesSql("t")} AS aliases
       FROM content_nodes t WHERE t.workspace_id = $1 AND t.id = $2 AND t.node_type = 'content' AND ${targetScope}`, params,
  )).rows[0];
  if (!target) return [];

  const sourceParams: unknown[] = [workspaceId, noteId];
  const sourceScope = readableScopeSql(actor, "s", sourceParams);
  const sources = (await q<{ id: string; title: string; markdown: string }>(
    `SELECT s.id::text, s.title, s.markdown
       FROM node_edges e JOIN content_nodes s ON s.id = e.source_node_id
      WHERE e.workspace_id = $1 AND e.target_node_id = $2 AND e.origin = 'wikilink' AND e.status = 'active'
        AND s.node_type = 'content' AND s.id <> e.target_node_id AND position('#^' in s.markdown) > 0 AND ${sourceScope}
      ORDER BY s.id LIMIT ${SOURCES_MAX}`, sourceParams,
  )).rows;

  const rows: BlockCitationRow[] = [];
  for (const source of sources) {
    const uses = new Map<string, number>();
    for (const c of blockCitations(source.markdown, target)) uses.set(c.blockId, (uses.get(c.blockId) ?? 0) + 1);
    for (const [block_ref, n] of uses) rows.push({ block_ref, source_id: source.id, source_title: source.title, uses: n });
  }
  return rows;
}

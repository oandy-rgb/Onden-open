// `![[Note#^id]]` that embeds an excerpt (@onden/markdown excerpt.ts) on the
// published site (user decision 2026-10-29): the excerpt itself — the quote and
// its source line with the original link — is written into the published
// note's text at publish time, even when the note it lives in (a private
// diary) is not published. An excerpt is a sentence of an article and a link
// back to it, which is what the owner wants public.
//
// Only that ONE paragraph leaves: whatever else the source note holds (the
// thoughts under the excerpt, the diary's other days), its title, id and a
// link to it stay private. The expansion is the same expandExcerptEmbeds the
// note export uses, so "what counts as an excerpt" and "what it looks like
// outside the app" have one definition. An embed that is not an excerpt, or
// whose note `actor` cannot read, is left as written for redaction.ts's
// ordinary rule. It runs BEFORE redaction (an embed of an unpublished note
// would otherwise already have become "(private)") and, like the rest of the
// snapshot, freezes: later edits to the diary do not reach the site.

import { embedMatches, expandExcerptEmbeds, servedLinkTarget, type ServedPage } from "@onden/markdown";
import { q } from "../../../db.js";
import type { ActorCtx } from "../../../types.js";
import { readableScopeSql } from "../../../services/readPolicy.js";
import { LISTED_NODE_SQL } from "../../../spine/reservedNodes.js";
import { nodeAliasesSql } from "../../../services/wikilinkEdges.js";
import { noteIdsHoldingAnchors, validAnchorRangesByNote } from "../../../services/blockAnchors/index.js";

type ExcerptHost = { id?: unknown; markdown?: unknown };
type SourceNote = ServedPage & { markdown: string };

/** Replace, in each of `nodes`, the lines that embed an excerpt with the
 *  excerpt. Notes are read as `actor` (null, an anonymous reader, reads none).
 *  Mutates `nodes`. */
export async function expandPublishedExcerpts(
  workspaceId: string, nodes: ExcerptHost[], actor: ActorCtx | null,
): Promise<void> {
  const wanted = new Set<string>();
  for (const n of nodes) {
    if (typeof n.markdown !== "string" || !n.markdown.includes("![[")) continue;
    for (const m of embedMatches(n.markdown)) if (m.blockId && m.target) wanted.add(m.blockId);
  }
  if (wanted.size === 0 || actor === null) return;
  // Only notes that hold one of the wanted anchors can be a source: the index of notes' anchors (noteIdsHoldingAnchors)
  // says which, so the whole workspace's text is not read.
  const holders = await noteIdsHoldingAnchors(workspaceId, [...wanted]);
  if (holders.length === 0) return;
  const params: unknown[] = [workspaceId, holders];
  const scope = readableScopeSql(actor, "cn", params);
  const rows = await q<{ id: string; title: string; slug: string; aliases: string[]; markdown: string }>(
    `SELECT cn.id::text, cn.title, cn.slug, ${nodeAliasesSql("cn")} AS aliases, cn.markdown
       FROM content_nodes cn
      WHERE cn.workspace_id = $1 AND cn.node_type = 'content' AND ${LISTED_NODE_SQL("cn")} AND ${scope}
        AND cn.id = ANY($2::uuid[])
      ORDER BY cn.created_at ASC, cn.id ASC`,
    params,
  );
  if (rows.rows.length === 0) return;
  const sources: SourceNote[] = rows.rows;
  const anchors = await validAnchorRangesByNote(workspaceId, sources.map((s) => s.id));
  for (const n of nodes) {
    if (typeof n.markdown !== "string" || !n.markdown.includes("![[")) continue;
    n.markdown = expandExcerptEmbeds(n.markdown, (m) => {
      const source = servedLinkTarget(m.target, sources, String(n.id));
      return source ? { markdown: source.markdown, anchors: anchors.get(source.id) ?? [] } : null;
    });
  }
}

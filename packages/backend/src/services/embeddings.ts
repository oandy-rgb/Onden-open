import { sha256Hex } from "../utils.js";
import { pool, q, requireTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { ActorCtx } from "../types.js";
import { getEmbedder, toVectorLiteral } from "./embedder.js";
import { readableNodeIdSet, readableScopeSql } from "./readPolicy.js";
import { NOT_SYSTEM_NODE_SQL } from "../spine/reservedNodes.js";
import { liveNodeSql } from "../spine/nodeSql.js";

// Whether a workspace has semantic search on is the module's question
// (modules/semantic): not imported, nothing is embedded and nothing here runs.

// Semantic-search pipeline over node_embeddings (migration 049). embedNode is
// the outbox 'embed' effect handler; semanticSearchNodes is the read path used
// by the audited semanticSearch agent tool.

/**
 * Compute + upsert a node's body embedding. Called by the outbox reconciler.
 * Skips the (expensive) model call when the body hash + model are unchanged, so
 * a re-enqueue for an unrelated reason doesn't recompute.
 */
export async function embedNode(workspaceId: string, nodeId: string, text: string): Promise<void> {
  const embedder = getEmbedder();
  const contentHash = sha256Hex(text);

  const existing = await pool.query<{ content_hash: string; model: string }>(
    `SELECT content_hash, model FROM node_embeddings WHERE node_id = $1`,
    [nodeId],
  );
  if (existing.rows[0]?.content_hash === contentHash && existing.rows[0]?.model === embedder.name) {
    return; // unchanged body, same model — nothing to recompute
  }

  const vec = await embedder.embed(text, "passage");
  await pool.query(
    `INSERT INTO node_embeddings (node_id, workspace_id, model, content_hash, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)
     ON CONFLICT (node_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id,
           model = EXCLUDED.model,
           content_hash = EXCLUDED.content_hash,
           embedding = EXCLUDED.embedding,
           updated_at = now()`,
    [nodeId, workspaceId, embedder.name, contentHash, toVectorLiteral(vec)],
  );
}

export type SemanticHit = {
  id: string;
  title: string;
  slug: string;
  distance: number; // cosine distance (0 = identical direction)
};

/**
 * Nearest nodes to a free-text query by cosine distance. Read-scoped to the
 * actor's COMBINED read set EVEN ON READ — embeddings are a shared vector store,
 * so a restricted node must not leak its title/slug (a side channel) to anyone
 * who can't read it. The bound is the canonical readableNodeIdSet: role/tag-policy
 * visibility (visibleNodeIdsForActor) ∩ bearer-token tag scope — the same rule
 * /api/bootstrap, sync, export and ask apply. Honouring only the token half was a
 * leak: a low-role HUMAN session (no tokenScope) could semantically pull in
 * restricted nodes (the one place read-scope must be tighter than
 * searchNodes/getNode — architecture-comparison doc 07). A null actor (internal
 * call) defaults to least-privilege (anonymous viewer) — it can never surface a
 * restricted node, only ordinary ones.
 *
 * Read scope is now a PUSHED-DOWN predicate on the joined node, so the cosine
 * ORDER BY + LIMIT rank over the actor's authorized rows directly. This removes
 * the old LIMIT × overscan candidate window (which over-scanned to refill a page
 * after a post-`<=>` .filter() dropped restricted hits, yet could still
 * under-fill when more than `overscan` of the top hits were restricted): the
 * query returns exactly the `limit` nearest READABLE nodes.
 */
export async function semanticSearchNodes(
  workspaceId: string,
  query: string,
  opts: { actor?: ActorCtx | null; limit?: number } = {},
): Promise<SemanticHit[]> {
  const limit = opts.limit ?? 10;

  const qvec = toVectorLiteral(await getEmbedder().embed(query, "query"));
  const params: unknown[] = [workspaceId, qvec];
  const scopeClause = readableScopeSql(opts.actor ?? null, "n", params);
  params.push(limit);
  const res = await q<SemanticHit>(
    `SELECT n.id, n.title, n.slug, (e.embedding <=> $2::vector) AS distance
       FROM node_embeddings e
       JOIN content_nodes n ON n.id = e.node_id
      WHERE e.workspace_id = $1 AND ${liveNodeSql("n")}
        AND ${scopeClause}
        -- never a system note, as in text search (reservedNodes)
        AND ${NOT_SYSTEM_NODE_SQL("n")}
      ORDER BY e.embedding <=> $2::vector
      LIMIT $${params.length}`,
    params,
  );
  return res.rows;
}

export type LinkSuggestion = { id: string; title: string; slug: string; distance: number };

/**
 * Nearest nodes to THIS node's body embedding that aren't already linked to it —
 * the "you might also connect these" candidates (fills the long-reserved
 * suggested_link slot). Excludes self, soft-deleted, and any node already joined
 * by an active edge in either direction. Read-scoped to the actor's COMBINED read
 * set (readableNodeIdSet), like semanticSearchNodes — a restricted target must
 * not surface its title/slug here, nor (via refreshSuggestedLinks) get a rendered
 * suggested_link edge, to a caller who can't read it. Returns [] when the node
 * hasn't been embedded yet, or the actor can read nothing.
 */
export async function suggestLinksForNode(
  workspaceId: string,
  nodeId: string,
  opts: { actor?: ActorCtx | null; limit?: number } = {},
): Promise<LinkSuggestion[]> {
  const limit = opts.limit ?? 5;
  const readable = await readableNodeIdSet(opts.actor ?? null, workspaceId);
  if (readable.size === 0) return [];

  const res = await q<LinkSuggestion>(
    `WITH src AS (SELECT embedding FROM node_embeddings WHERE node_id = $2)
     SELECT n.id, n.title, n.slug, (e.embedding <=> src.embedding) AS distance
       FROM node_embeddings e
       JOIN content_nodes n ON n.id = e.node_id
       CROSS JOIN src
      WHERE e.workspace_id = $1
        AND n.id <> $2
        AND ${liveNodeSql("n")}
        AND n.id = ANY($4::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM node_edges ed
           WHERE ed.workspace_id = $1 AND ed.status = 'active'
             AND ((ed.source_node_id = $2 AND ed.target_node_id = n.id)
               OR (ed.source_node_id = n.id AND ed.target_node_id = $2))
        )
      ORDER BY e.embedding <=> src.embedding
      LIMIT $3`,
    // The read set is applied BEFORE the LIMIT: filtering afterwards left a
    // restricted reader with fewer (or no) suggestions than exist for them.
    [workspaceId, nodeId, limit, [...readable]],
  );
  return res.rows;
}

/** Replace a note's semantic suggestions (derived node_edges rows). Inside the
 *  caller's event transaction: a bare call would rewrite edges with no lock. */
async function writeSuggestedLinks(workspaceId: string, nodeId: string, suggestions: readonly LinkSuggestion[]): Promise<void> {
  requireTransaction("writeSuggestedLinks");
  await q(
    `DELETE FROM node_edges
      WHERE workspace_id = $1 AND source_node_id = $2
        AND edge_type = 'suggested_link' AND origin = 'semantic' AND status = 'suggested'`,
    [workspaceId, nodeId],
  );
  for (const s of suggestions) {
    await q(
      `INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin)
       VALUES ($1, $2, $3, 'suggested_link', 'suggested', 'semantic')
       ON CONFLICT (workspace_id, source_node_id, target_node_id, edge_type, origin)
       DO UPDATE SET status = 'suggested'`,
      [workspaceId, nodeId, s.id],
    );
  }
}

/**
 * Recompute a node's semantic suggestions and persist them as suggested_link
 * edges (status='suggested', origin='semantic') so the canvas/graph renders
 * them. A transactional replace of just THIS node's semantic SUGGESTIONS —
 * confirmed edges (status='active') and other origins are untouched. No
 * domain_event: suggestions are a derived projection of embeddings (like the
 * embeddings themselves); confirming one goes through POST /api/edges, which is
 * the audited write.
 */
export async function refreshSuggestedLinks(
  workspaceId: string,
  nodeId: string,
  opts: { actor?: ActorCtx | null; limit?: number } = {},
): Promise<LinkSuggestion[]> {
  // The embedding lookup runs before the event lock is taken; only the edge
  // rewrite holds it.
  const suggestions = await suggestLinksForNode(workspaceId, nodeId, opts);
  await withEventTransaction(workspaceId, () => writeSuggestedLinks(workspaceId, nodeId, suggestions));
  return suggestions;
}

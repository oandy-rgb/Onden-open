// Read-scope side-channel guard for the EMBEDDINGS vector store (security item
// restricted-content-side-channels, channel (a)).
//
// node_embeddings is a SHARED store: every node's body vector lands in one table.
// The read path (semanticSearchNodes / suggestLinksForNode) must therefore bound
// its results by the caller's COMBINED read set (readPolicy.readableNodeIdSet =
// role/tag-policy visibility ∩ bearer-token tag scope) — NOT by the token tag
// scope alone. Honouring only the token half was a leak: a low-role HUMAN session
// (role=viewer, no tokenScope) bypassed the role/tag-policy read rule and could
// semantically pull back a restricted node's id/title/slug — and, via
// refreshSuggestedLinks, get a rendered suggested_link edge pointing at it.
//
// This pins the ROLE half specifically (the token half is covered by
// embeddings.integration.test.ts / readToolsScope.integration.test.ts):
//   - a viewer must NOT surface a node in an admin-only space by semantic similarity
//   - a viewer must NOT get a suggested_link to such a node
//   - an admin (default principal) still sees it (the rule is a boundary, not a wall)
//
// Stub embedder (default EMBEDDING_MODE) → deterministic + offline. SAFETY: only
// runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, q } from "../db.js";
import { semanticSearchNodes, suggestLinksForNode, refreshSuggestedLinks } from "../services/embeddings.js";
import { embedNode } from "../services/embeddings.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const WS = "00000000-0000-0000-0000-0000000e5c09";

// Human sessions carry a role and NO tokenScope — the case the old token-only
// scope check missed entirely.
let viewer: ActorCtx = { id: "low", name: "Viewer", role: "viewer", type: "human" };
let admin: ActorCtx = { id: "own", name: "Owner", role: "admin", type: "human" };

describe.skipIf(!isTestDb)("embeddings read-scope side channel — role/tag-policy is honoured (DB)", () => {
  let openId = "", secretId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'EmbScope','emb-scope-ws')
             ON CONFLICT (id) DO NOTHING`, [WS]);
    await q(`DELETE FROM node_embeddings WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);

    const open = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Open note','emb-scope-open','SHAREDVEC open body') RETURNING id`, [WS]);
    openId = open.rows[0]!.id;

    viewer = await persistActor(WS, viewer);
    admin = await persistActor(WS, admin);
    const secret = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Restricted salary table','emb-scope-secret','SHAREDVEC secret body') RETURNING id`, [WS]);
    secretId = secret.rows[0]!.id;
    // Restricted: in a space only the admin belongs to.
    await putInSpace(secretId, await adminOnlySpace(WS, "emb-sec", [admin.id]));

    // Both share the SAME embed text → cosine distance 0 between them, so the
    // secret is the literal nearest neighbour to the open note. If scoping were
    // absent it WOULD surface — that's what makes this a real leak test.
    await embedNode(WS, openId, "SHAREDVEC");
    await embedNode(WS, secretId, "SHAREDVEC");
  });

  afterAll(async () => {
    await q(`DELETE FROM node_embeddings WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM workspaces WHERE id = $1`, [WS]);
    await pool.end();
  });

  it("a viewer (no token) must NOT surface a read:admin node via semantic search", async () => {
    const hits = await semanticSearchNodes(WS, "SHAREDVEC", { actor: viewer, limit: 10 });
    expect(hits.some((h) => h.id === secretId)).toBe(false);
    // the open one (no restrictive tag) still comes back for the viewer
    expect(hits.some((h) => h.id === openId)).toBe(true);
  });

  it("an admin DOES surface the restricted node (read-policy is a boundary, not a wall)", async () => {
    const hits = await semanticSearchNodes(WS, "SHAREDVEC", { actor: admin, limit: 10 });
    expect(hits.some((h) => h.id === secretId)).toBe(true);
  });

  it("suggestLinksForNode must NOT propose a read:admin node to a viewer", async () => {
    const sug = await suggestLinksForNode(WS, openId, { actor: viewer, limit: 10 });
    expect(sug.some((s) => s.id === secretId)).toBe(false);
    // admin gets the secret as a candidate (it's the nearest neighbour)
    const adminSug = await suggestLinksForNode(WS, openId, { actor: admin, limit: 10 });
    expect(adminSug.some((s) => s.id === secretId)).toBe(true);
  });

  it("refreshSuggestedLinks must NOT persist a suggested_link edge to a restricted node for a viewer", async () => {
    await refreshSuggestedLinks(WS, openId, { actor: viewer, limit: 10 });
    const edge = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM node_edges
        WHERE source_node_id = $1 AND target_node_id = $2 AND edge_type = 'suggested_link'`,
      [openId, secretId]);
    expect(edge.rows[0]!.n).toBe(0);
  });

  it("a null actor defaults to least-privilege: a member of no space reads nothing", async () => {
    // readableNodeIdSet(null) → no readable spaces. So an internal call with no
    // actor can never leak a restricted node (nor any other note).
    const hits = await semanticSearchNodes(WS, "SHAREDVEC", { actor: null, limit: 10 });
    expect(hits.some((h) => h.id === secretId)).toBe(false);
    expect(hits.some((h) => h.id === openId)).toBe(false);
  });
});

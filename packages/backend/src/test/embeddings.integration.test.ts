// Integration test for the semantic-search pipeline (migration 049): the embed
// outbox effect populates node_embeddings, and semanticSearchNodes returns
// nearest nodes by cosine distance with the reader's space scope (and a bearer
// token's read-space scope) honoured on reads (docs/architecture/spaces.md).
//
// Uses the deterministic stub embedder (default EMBEDDING_MODE), so it runs
// offline: an exact text match has cosine distance 0 and therefore ranks first.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q, withTransaction } from "../db.js";
import { drainOutbox } from "../services/outbox.js";
import { nodeContentCommitted } from "../services/nodeCommits.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

// The embed effect and its content hook belong to the semantic module.
registerShippedModules();
import { semanticSearchNodes, suggestLinksForNode, refreshSuggestedLinks } from "../services/embeddings.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A workspace of its own per test (beforeEach): the counts and nearest
// neighbours below must not see another test's nodes (gamma shares alpha's
// vector, delta beta's).
let WS = "";
const workspaces: string[] = [];

async function mkNode(title: string, slug: string, markdown: string): Promise<string> {
  const r = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
     VALUES ($1, 'content', 'manual', $2, $3, $4) RETURNING id`,
    [WS, title, slug, markdown],
  );
  return r.rows[0]!.id;
}

// Reads are space-scoped: a reader who belongs to the workspace's default
// space (where raw-inserted notes land). An absent actor reads nothing.
let owner: ActorCtx;
let agent: ActorCtx;
// A read token reaches exactly its agent's spaces (membership; there is no
// per-token space list), so "scoped to X" means an agent that is only in X.
async function scoped(spaceIds: string[]): Promise<ActorCtx> {
  const tokenAgent = await persistActor(WS, {
    id: "agent-scoped", name: "Scoped agent", type: "agent",
    tokenScope: { tokenId: "tk-test", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
  });
  await q(`DELETE FROM space_members WHERE actor_id = $1`, [tokenAgent.id]);
  for (const spaceId of spaceIds) {
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view')`, [spaceId, tokenAgent.id]);
  }
  return tokenAgent;
}

describe.skipIf(!isTestDb)("semantic search pipeline (DB)", () => {
  let alpha = "", beta = "", defaultSpace = "", otherSpace = "";

  beforeEach(async () => {
    WS = randomUUID();
    workspaces.push(WS);
    await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1, 'EmbTest', $2)`, [WS, `emb-test-${WS}`]);
    await setModulesOn(WS, null);
    owner = await persistActor(WS, { id: "emb-owner", name: "Owner", role: "admin", type: "human" });
    agent = await persistActor(WS, { id: "agent-x", name: "Agent", role: "editor", type: "agent" });
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    alpha = await mkNode("Alpha", "emb-alpha", "body-a");
    beta = await mkNode("Beta", "emb-beta", "body-b");
    // beta lives in a second space both readers belong to; alpha stays in the
    // default space.
    const other = await makeSpace(WS, `emb-other-${Date.now()}`, [
      { id: owner.id, permission: "edit" }, { id: agent.id, permission: "edit" }]);
    otherSpace = other;
    await putInSpace(beta, other);

    // Enqueue distinct embed texts, then drain through the real (stub) embedder.
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: alpha, text: "ALPHA-VECTOR" }));
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: beta, text: "BETA-VECTOR" }));
    await drainOutbox({ workspaceId: WS });
  });

  afterAll(async () => {
    await q(`DELETE FROM node_embeddings WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await q(`DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await pool.end();
  });

  it("the embed outbox effect populated node_embeddings with the stub model", async () => {
    const r = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM node_embeddings WHERE workspace_id = $1 AND model = 'stub-v1'`, [WS]);
    expect(r.rows[0]!.n).toBe(2);
  });

  it("semanticSearchNodes ranks an exact text match first (distance ~0)", async () => {
    const hits = await semanticSearchNodes(WS, "ALPHA-VECTOR", { actor: owner, limit: 5 });
    expect(hits[0]!.id).toBe(alpha);
    expect(hits[0]!.distance).toBeLessThan(1e-6);
    const betaHits = await semanticSearchNodes(WS, "BETA-VECTOR", { actor: owner, limit: 5 });
    expect(betaHits[0]!.id).toBe(beta);
  });

  it("re-enqueue with the SAME body is a no-op (skip-if-unchanged)", async () => {
    const before = await q<{ updated_at: string }>(`SELECT updated_at FROM node_embeddings WHERE node_id = $1`, [alpha]);
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: alpha, text: "ALPHA-VECTOR" }));
    await drainOutbox({ workspaceId: WS });
    const after = await q<{ updated_at: string }>(`SELECT updated_at FROM node_embeddings WHERE node_id = $1`, [alpha]);
    // pg returns timestamptz as a Date; compare by value (same instant → the
    // row was NOT re-written, i.e. the unchanged-body skip fired).
    expect(String(after.rows[0]!.updated_at)).toBe(String(before.rows[0]!.updated_at));
  });

  it("a token only sees results in its agent's spaces (read-scope tightening)", async () => {
    // Only alpha is in the default space; a token whose agent is only there must not see beta.
    const onlyScoped = await semanticSearchNodes(WS, "BETA-VECTOR", { actor: await scoped([defaultSpace]), limit: 5 });
    expect(onlyScoped.every((h) => h.id !== beta)).toBe(true);
    expect(onlyScoped.some((h) => h.id === alpha)).toBe(true);

    // An agent in no space → no results.
    expect(await semanticSearchNodes(WS, "ALPHA-VECTOR", { actor: await scoped([]), limit: 5 })).toEqual([]);

    // An agent in both spaces sees both, beta included.
    const unrestricted = await semanticSearchNodes(WS, "BETA-VECTOR", { actor: await scoped([defaultSpace, otherSpace]), limit: 5 });
    expect(unrestricted.some((h) => h.id === beta)).toBe(true);
  });

  it("suggestLinksForNode returns nearest non-linked nodes, then excludes a linked one", async () => {
    // gamma shares alpha's embed text → distance 0 → alpha's top suggestion.
    const gamma = await mkNode("Gamma", "emb-gamma", "body-g");
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: gamma, text: "ALPHA-VECTOR" }));
    await drainOutbox({ workspaceId: WS });
    let sug = await suggestLinksForNode(WS, alpha, { actor: owner, limit: 5 });
    expect(sug[0]!.id).toBe(gamma);
    expect(sug[0]!.distance).toBeLessThan(1e-6);

    // Once alpha↔gamma is an active edge, gamma drops out of the suggestions.
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin)
             VALUES ($1, $2, $3, 'knowledge_link', 'active', 'test')`, [WS, alpha, gamma]);
    sug = await suggestLinksForNode(WS, alpha, { actor: owner, limit: 5 });
    expect(sug.some((s) => s.id === gamma)).toBe(false);
  });

  it("refreshSuggestedLinks persists suggested_link edges and replaces on re-run (no growth)", async () => {
    const delta = await mkNode("Delta", "emb-delta", "body-d");
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: delta, text: "BETA-VECTOR" })); // ~= beta
    await drainOutbox({ workspaceId: WS });

    const first = await refreshSuggestedLinks(WS, beta, { actor: owner, limit: 5 });
    expect(first.some((x) => x.id === delta)).toBe(true);
    const edge = await q<{ status: string; origin: string }>(
      `SELECT status, origin FROM node_edges
        WHERE source_node_id = $1 AND target_node_id = $2 AND edge_type = 'suggested_link'`, [beta, delta]);
    expect(edge.rows[0]!.status).toBe("suggested");
    expect(edge.rows[0]!.origin).toBe("semantic");

    // Re-run replaces (delete-then-insert), so the count doesn't grow.
    await refreshSuggestedLinks(WS, beta, { actor: owner, limit: 5 });
    const n = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM node_edges
        WHERE source_node_id = $1 AND edge_type = 'suggested_link' AND origin = 'semantic'`, [beta]);
    expect(n.rows[0]!.n).toBe(first.length);
  });
});

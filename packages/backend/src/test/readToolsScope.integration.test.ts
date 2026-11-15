// Read-TOOL space scope through callTool (audit #1, CI regression). The bulk REST
// reads and the embeddings *service* are tested elsewhere; this pins the agent
// TOOL surface (searchNodes / getNode / semanticSearch) end-to-end through
// callTool — the scoping added in #1 was previously only exercised by the
// bMcpSmoke script (not in the vitest suite). Under spaces
// (docs/architecture/spaces.md) a token whose read scope names only space A
// must not see / fetch nodes in space B (a token's reach is its agent's space
// memberships, so "scoped to A" = an agent that is a member of A only); a principal (no tokenScope) who is a
// member of both sees everything.
//
// Uses the deterministic stub embedder (default EMBEDDING_MODE) → offline.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, withTransaction } from "../db.js";
import { drainOutbox } from "../services/outbox.js";
import { nodeContentCommitted } from "../services/nodeCommits.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

// The embed effect and its content hook belong to the semantic module.
registerShippedModules();
import { callTool } from "../services/agentTools/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const WS = "00000000-0000-0000-0000-00000000a5a5";

let human: ActorCtx = { id: "owner", name: "Owner", role: "admin", type: "human" }; // no tokenScope
// Three agents behind read tokens: a member of only the allowed space, and one
// that belongs to no space at all (a token that reaches nothing).
const tokenScope = { tokenId: "tk", allowedTools: null, access: "read" as const, writeMode: "apply" as const, expiresAt: null };
let agentA: ActorCtx = { id: "agent-a", name: "Bot A", role: "editor", type: "agent", tokenScope };
let agentNone: ActorCtx = { id: "agent-none", name: "Bot none", role: "editor", type: "agent", tokenScope };

describe.skipIf(!isTestDb)("read-tool space scope via callTool (DB)", () => {
  let inScope = "", outScope = "", allowedSpace = "", otherSpace = "";
  const ctx = (actor: ActorCtx) => ({ actor, workspaceId: WS, dryRun: false });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'RT','rt-tools-ws') ON CONFLICT (id) DO NOTHING`, [WS]);
    await setModulesOn(WS, null);
    await q(`DELETE FROM node_embeddings WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);
    human = await persistActor(WS, human);
    agentA = await persistActor(WS, agentA);
    agentNone = await persistActor(WS, agentNone);
    // persistActor joins the default space; these agents' reach is set below.
    await q(`DELETE FROM space_members WHERE actor_id = ANY($1::uuid[])`, [[agentA.id, agentNone.id]]);
    const members = [{ id: human.id, permission: "edit" as const }];
    allowedSpace = await makeSpace(WS, `rt-allowed-${Date.now()}`, [...members, { id: agentA.id, permission: "edit" }]);
    otherSpace = await makeSpace(WS, `rt-other-${Date.now()}`, members);
    const mkNode = async (title: string, slug: string, body: string, space: string) => {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
         VALUES ($1,'content','manual',$2,$3,$4) RETURNING id`, [WS, title, slug, body],
      )).rows[0]!.id;
      await putInSpace(id, space);
      return id;
    };
    // Both bodies share the keyword "quark" (so searchNodes matches both).
    inScope = await mkNode("InScope quark", "rt-in", "the quark INSCOPEVEC", allowedSpace);
    outScope = await mkNode("OutScope quark", "rt-out", "the quark OUTSCOPEVEC", otherSpace);
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: inScope, text: "INSCOPEVEC" }));
    await withTransaction(() => nodeContentCommitted({ workspaceId: WS, nodeId: outScope, text: "OUTSCOPEVEC" }));
    await drainOutbox({ workspaceId: WS });
  });

  it("searchNodes: scoped token excludes out-of-scope hits; principal sees both", async () => {
    const scopedIds = ((await callTool("searchNodes", { query: "quark" }, ctx(agentA))) as Array<{ id: string }>).map((r) => r.id);
    expect(scopedIds).toContain(inScope);
    expect(scopedIds).not.toContain(outScope);
    const humanIds = ((await callTool("searchNodes", { query: "quark" }, ctx(human))) as Array<{ id: string }>).map((r) => r.id);
    expect(humanIds).toEqual(expect.arrayContaining([inScope, outScope]));
  });

  it("getNode: scoped token fetches in-scope, but out-of-scope resolves to null (no oracle)", async () => {
    expect((await callTool("getNode", { id: inScope }, ctx(agentA)) as { id: string } | null)?.id).toBe(inScope);
    expect(await callTool("getNode", { id: outScope }, ctx(agentA))).toBeNull();
    // principal can fetch the out-of-scope one
    expect((await callTool("getNode", { id: outScope }, ctx(human)) as { id: string } | null)?.id).toBe(outScope);
  });

  it("getNode by slug: a slug taken in two spaces resolves to the one the caller may read (W9)", async () => {
    // Slugs are unique per space. The out-of-scope twin is older, so a query
    // that picked a row before checking access returned null here.
    const twin = async (title: string, space: string, createdAt: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown, space_id, created_at)
       VALUES ($1,'content','manual',$2,'rt-twin','',$3,$4) RETURNING id`, [WS, title, space, createdAt],
    )).rows[0]!.id;
    await twin("Hidden twin", otherSpace, "2020-01-01T00:00:00Z");
    const mine = await twin("My twin", allowedSpace, "2024-01-01T00:00:00Z");
    expect((await callTool("getNode", { slug: "rt-twin" }, ctx(agentA)) as { id: string } | null)?.id).toBe(mine);
    expect(await callTool("getNode", { slug: "rt-twin" }, ctx(agentNone))).toBeNull();
  });

  it("semanticSearch: scoped token never surfaces an out-of-scope node", async () => {
    const scopedIds = ((await callTool("semanticSearch", { query: "OUTSCOPEVEC", limit: 5 }, ctx(agentA))) as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(scopedIds).not.toContain(outScope);
    // an agent in no space → no results at all
    const none = ((await callTool("semanticSearch", { query: "INSCOPEVEC", limit: 5 }, ctx(agentNone))) as { results: unknown[] }).results;
    expect(none).toEqual([]);
    // principal sees the out-of-scope node as the nearest match
    const humanIds = ((await callTool("semanticSearch", { query: "OUTSCOPEVEC", limit: 5 }, ctx(human))) as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(humanIds).toContain(outScope);
  });

  it("suggestLinks: scoped token never proposes an out-of-scope node; principal can", async () => {
    const scopedSug = ((await callTool("suggestLinks", { nodeId: inScope, limit: 5 }, ctx(agentA))) as { suggestions: Array<{ id: string }> }).suggestions.map((s) => s.id);
    expect(scopedSug).not.toContain(outScope);
    const humanSug = ((await callTool("suggestLinks", { nodeId: inScope, limit: 5 }, ctx(human))) as { suggestions: Array<{ id: string }> }).suggestions.map((s) => s.id);
    expect(humanSug).toContain(outScope);
  });
});

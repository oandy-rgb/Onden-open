// Red-audit regression (mcp-searchnodes-readpolicy): the MCP `searchNodes`
// agent tool must bound its hits by the SAME combined read set the HTTP
// /api/nodes/search route applies — space membership ∩ bearer-token
// space scope (readableNodeIdSet) — NOT token scope alone. Before the fix it
// filtered with only tokenReadableNodeIds, so an agent acting as a low-role
// actor (or any actor whose tag READ-policy outranks it) could surface
// restricted note titles/snippets straight out of search results, a read-
// chokepoint bypass on the agent surface that drifted from the HTTP path.
//
// Seed: a node in an admin-only space + a public node, both matching a
// unique query term. Pin: the agent-as-viewer's results exclude the restricted
// node; the agent-as-admin's include it.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { searchNodes as searchNodesSvc } from "../services/nodeSearch.js";
import { q, getWorkspaceId } from "../db.js";
import { searchNodes } from "../services/agentTools/searchNodes.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let viewer: ActorCtx = { id: "sn-viewer", name: "ViewerBot", role: "viewer", type: "agent" };
let admin: ActorCtx = { id: "sn-admin", name: "AdminBot", role: "admin", type: "agent" };

describe.skipIf(!isTestDb)("searchNodes agent tool read-policy (DB)", () => {
  let WS = "";
  let secretId = "";
  let publicId = "";
  let term = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    const stamp = Date.now();
    // A unique, alpha-only term so the two seeded nodes are the only matches.
    term = `znkqsearch${stamp}`;

    viewer = await persistActor(WS, viewer);
    admin = await persistActor(WS, admin);

    const secret = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Restricted ${term}','sn-secret-node-${stamp}','top secret ${term} body') RETURNING id`,
      [WS]);
    secretId = secret.rows[0]!.id;
    // Restricted: in a space only the admin belongs to.
    await putInSpace(secretId, await adminOnlySpace(WS, `sn-secret-${stamp}`, [admin.id]));

    const pub = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Public ${term}','sn-public-${stamp}','hello ${term}') RETURNING id`,
      [WS]);
    publicId = pub.rows[0]!.id;
  });

  const run = (actor: ActorCtx) =>
    searchNodes.handler({ query: term, limit: 20 }, { actor, workspaceId: WS });

  it("agent-as-viewer: results exclude policy-restricted nodes", async () => {
    const rows = await run(viewer);
    expect(rows.some((r) => r.id === publicId)).toBe(true);
    expect(rows.some((r) => r.id === secretId)).toBe(false);
  });

  it("agent-as-admin: results include the restricted node", async () => {
    const rows = await run(admin);
    expect(rows.some((r) => r.id === publicId)).toBe(true);
    expect(rows.some((r) => r.id === secretId)).toBe(true);
  });

  it("MB4/D76: the snippet is plain text + highlight ranges, never pgroonga's HTML", async () => {
    const admin = await persistActor(WS, { id: "", name: "Admin", role: "admin", type: "human" });
    const rows = await searchNodesSvc(WS, term, admin, 20);
    const hit = rows.find((r) => r.id === publicId);
    expect(hit).toBeTruthy();
    expect(hit!.snippet).toEqual({ text: `hello ${term}`, ranges: [[6, 6 + term.length]] });
    // The agent tool returns the same contract (it wraps the same service).
    const tool = (await run(admin)).find((r) => r.id === publicId);
    expect(tool!.snippet).toEqual(hit!.snippet);
  });

  it("search keeps notes the user hid from the tree", async () => {
    const hidden = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden)
       VALUES ($1,'manual','content','Hidden ${term}','sn-hidden-${Date.now()}','hidden ${term}', true) RETURNING id`,
      [WS]);
    expect((await searchNodesSvc(WS, term, admin)).map((r) => r.id)).toContain(hidden.rows[0]!.id);
  });
});

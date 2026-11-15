// B-group read-authorization gaps (P0 stop-the-bleed). Three per-node read
// leaks that bypassed the canReadNode gate every other per-node endpoint
// enforces:
//
//   1. GET /api/nodes/block/:blockId resolved a block-ref to its host node and
//      returned that node's slug + title WITHOUT a read check → any logged-in
//      actor could harvest a restricted node's title/slug via its block ids.
//      (The route and its index are gone since D59, migration 108: links
//      resolve from the note's own text. The case pins that it stays gone.)
//   2. POST /api/pointers created a pointer to target_id checking only the WRITE
//      role, never canReadNode(target) → a scoped actor could reference (and
//      clone into its own tree) a node it can't read.
//   3. services/readPolicy.ts ancestor cascade capped at `depth < 10`, so a node
//      nested > 10 levels under a read-restricted ancestor never inherited that
//      ancestor's policy (silent fail-open). Under spaces
//      (docs/architecture/spaces.md) a whole subtree lives in one space, so a
//      deep leaf under a restricted root must be just as unreadable.
//
// "Restricted" = in an admin-only space the viewer is not in; a scoped bearer
// token = one whose agent is a member of only the "scope" space.
// Each case pins: the restricted actor (a viewer, or a space-scoped bearer
// token crossing its grant) is BLOCKED after the fix; the admin / in-scope
// actor still works.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import pointerRouter from "../routes/pointers.js";
import edgesRouter from "../routes/edges.js";
import { readableNodeIdSet } from "../services/readPolicy.js";
import { canReadMedia } from "../services/mediaAccess.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/pointers", pointerRouter);
app.route("/api/edges", edgesRouter);

let viewer: ActorCtx = { id: "bz-viewer", name: "Viewer", role: "viewer", type: "human" };
let admin: ActorCtx = { id: "bz-admin", name: "Admin", role: "admin", type: "human" };
// An agent that edits `spaceId` and nothing else (a token's reach is its
// agent's memberships), behind a write token: it reads and writes `spaceId` only.
async function scopedToken(workspaceId: string, spaceId: string): Promise<ActorCtx> {
  const actor = await persistActor(workspaceId, {
    id: "bz-agent", name: "Bot", role: "editor", type: "agent",
    tokenScope: { tokenId: "bz-tk", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
  });
  // persistActor joined the default space; drop it so only `spaceId` is reachable.
  await q(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [actor.id]);
  await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit')`, [spaceId, actor.id]);
  return actor;
}

describe.skipIf(!isTestDb)("B-group read-authz gaps (DB)", () => {
  const stamp = Date.now();
  let WS = "";
  let secretId = "";     // in an admin-only space
  let publicId = "";     // in the default space
  let secretBlockId = "";
  let scopeSpaceId = ""; // the space a scoped token holds
  let inScopeId = "";    // in scopeSpace → in the token's grant
  let outScopeId = "";   // in the default space → outside the token's grant
  let deepLeafId = "";   // 12 levels under a read-restricted ancestor
  const mediaFile = `bz-cover-${stamp}.png`; // embedded ONLY in secretId's attribute

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    viewer = await persistActor(WS, viewer);
    admin = await persistActor(WS, admin);

    // ---- an admin-only space (the old admin-read class tag) ----
    const secretSpaceId = await adminOnlySpace(WS, `bz-secret-${stamp}`, [admin.id]);

    // ---- case 1 + 2 seed: a restricted node (with a block id) + a public node ----
    const secret = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Restricted B title ${stamp}','bz-secret-node-${stamp}','secret body ^bzsec-${stamp}') RETURNING id`,
      [WS]);
    secretId = secret.rows[0]!.id;
    await putInSpace(secretId, secretSpaceId);

    const pub = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Public B note ${stamp}','bz-public-${stamp}','hi') RETURNING id`,
      [WS]);
    publicId = pub.rows[0]!.id;
    secretBlockId = `bzsec-${stamp}`;

    // ---- case 2 (token scope) seed: an in-scope + an out-of-scope node ----
    scopeSpaceId = await makeSpace(WS, `bz-scope-${stamp}`, [{ id: admin.id, permission: "edit" }]);
    inScopeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','In scope ${stamp}','bz-inscope-${stamp}','x') RETURNING id`, [WS])).rows[0]!.id;
    await putInSpace(inScopeId, scopeSpaceId);
    outScopeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Out of scope ${stamp}','bz-outscope-${stamp}','y') RETURNING id`, [WS])).rows[0]!.id;

    // ---- case 3 seed: a 13-node chain (restricted root + 12 descendants) ----
    // The root goes into the admin-only space (with its whole subtree). The
    // leaf is 12 levels below it — beyond the old depth<10 cap, which once let
    // a viewer read it.
    let parent: string | null = null;
    let firstId = "";
    for (let i = 0; i < 13; i++) {
      const id: string = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
         VALUES ($1,'manual','content',$2,$3,'deep',$4) RETURNING id`,
        [WS, `bz-deep-${i}-${stamp}`, `bz-deep-${i}-${stamp}`, parent])).rows[0]!.id;
      if (i === 0) firstId = id;
      parent = id;
    }
    deepLeafId = parent!;
    // Move the chain root (depth 0) into the admin-only space.
    await putInSpace(firstId, secretSpaceId);

    // ---- case 4 seed: a media asset embedded ONLY in the restricted node's
    // ATTRIBUTE (a collection cover image / media field), never in its markdown.
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       VALUES ($1,$2,'cover_image',$3,'text',false,'ui')`,
      [WS, secretId, `/api/media/${mediaFile}`]);
  });

  // ---- Case 1: GET /api/nodes/block/:blockId ----
  it("block-ref: the route is gone, so it tells no one a restricted note's title", async () => {
    currentActor = viewer;
    const res = await app.request(`/api/nodes/block/${secretBlockId}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Restricted B title");
  });

  // ---- Case 2: POST /api/pointers ----
  it("pointers: a viewer cannot create a pointer to a read-restricted target; an admin can", async () => {
    const create = (targetId: string) => app.request("/api/pointers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_id: targetId }),
    });

    currentActor = viewer;
    const vRes = await create(secretId);
    expect(vRes.status).toBe(404); // blocked at the read gate, not the write gate

    currentActor = admin;
    const aRes = await create(secretId);
    expect(aRes.status).toBe(201);
    await q(`DELETE FROM note_pointers WHERE workspace_id=$1 AND target_id=$2`, [WS, secretId]); // cleanup
  });

  it("pointers: a space-scoped token cannot create a pointer across its grant", async () => {
    const create = (targetId: string) => app.request("/api/pointers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_id: targetId }),
    });

    currentActor = await scopedToken(WS, scopeSpaceId);
    // out-of-scope target → blocked
    const out = await create(outScopeId);
    expect(out.status).toBe(404);
    // in-scope target → allowed
    const inn = await create(inScopeId);
    expect(inn.status).toBe(201);
    await q(`DELETE FROM note_pointers WHERE workspace_id=$1 AND target_id=$2`, [WS, inScopeId]); // cleanup
  });

  // ---- Case 4: canReadMedia covers attribute-embedded assets ----
  it("media: an asset embedded ONLY in a restricted node's attribute is NOT public", async () => {
    // The ref set was markdown-only, so an attribute-embedded asset had an empty
    // ref set → 'unattached → public' served it to anyone. node_attributes refs
    // are now unioned in, so the host node's read policy applies.
    expect(await canReadMedia(null, mediaFile, WS)).toBe(false);   // anonymous
    expect(await canReadMedia(viewer, mediaFile, WS)).toBe(false); // low-role
    expect(await canReadMedia(admin, mediaFile, WS)).toBe(true);   // reads the host
  });

  // ---- Case 5: cross-node reference read-gates (create/reparent/pointer parent) ----
  it("create: a write-capable actor cannot seed a child under a read-restricted parent", async () => {
    const create = (parent: string, title: string) => app.request("/api/nodes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, markdown: "x", parent_id: parent }),
    });
    // editor-role bearer, but space-scoped away from the secret → can write, can't read it
    currentActor = await scopedToken(WS, scopeSpaceId);
    expect((await create(secretId, `bz-child-blocked-${stamp}`)).status).toBe(404);
    currentActor = admin;
    const ok = await create(secretId, `bz-child-ok-${stamp}`);
    expect(ok.status).toBe(201);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id=$1 AND title=$2`, [WS, `bz-child-ok-${stamp}`]);
  });

  it("reparent: cannot move a node under a read-restricted parent", async () => {
    const mv = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'x') RETURNING id`,
      [WS, `bz-mv-${stamp}`, `bz-mv-${stamp}`])).rows[0]!.id;
    // Isolate destination readability: the token must be allowed to edit the
    // source. Otherwise the earlier source authority gate correctly returns 403.
    await putInSpace(mv, scopeSpaceId);
    const reparent = (parent: string) => app.request(`/api/nodes/${mv}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_id: parent }),
    });
    currentActor = await scopedToken(WS, scopeSpaceId);
    expect((await reparent(secretId)).status).toBe(404);
    // The admin reads the secret, but a reparent never crosses spaces (that is
    // a space move, refused here as 409); within a space it goes through.
    currentActor = admin;
    expect((await reparent(secretId)).status).toBe(409);
    expect((await reparent(inScopeId)).status).toBe(200);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id=$1 AND id=$2`, [WS, mv]);
  });

  it("pointers: cannot place a pointer under a read-restricted parent", async () => {
    // target is in the token's scope (so the TARGET gate passes) — isolates the
    // PARENT gate: parent=secretId is unreadable to the scoped actor → 404.
    const create = (parent: string) => app.request("/api/pointers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_id: inScopeId, parent_id: parent }),
    });
    currentActor = await scopedToken(WS, scopeSpaceId);
    expect((await create(secretId)).status).toBe(404);
    currentActor = admin;
    expect((await create(secretId)).status).toBe(201);
    await q(`DELETE FROM note_pointers WHERE workspace_id=$1 AND target_id=$2`, [WS, inScopeId]);
  });

  it("edges: cannot create an edge to a read-restricted target; admin can to a readable one", async () => {
    // The edge-target leak (now in routes/edges.ts) — write_node on the source
    // alone let a writer mint a reference to ANY uuid. The target read-gate 404s
    // before any write, so an unreadable target is indistinguishable from absent.
    const create = (source: string, target: string) => app.request("/api/edges", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_node_id: source, target_node_id: target, edge_type: "knowledge_link" }),
    });
    currentActor = await scopedToken(WS, scopeSpaceId);
    expect((await create(inScopeId, secretId)).status).toBe(404); // restricted target
    currentActor = admin;
    expect((await create(publicId, inScopeId)).status).toBe(201); // readable target
    await seedQ(`DELETE FROM node_edges WHERE workspace_id=$1 AND source_node_id=$2`, [WS, publicId]);
  });

  // ---- Case 3: deep ancestor cascade (readPolicy depth cap removed) ----
  it("a leaf > 10 levels under a restricted root is restricted too", async () => {
    // A viewer must NOT see the deep leaf — the whole subtree is in the
    // admin-only space. Before the old fix this leaked (fail-open).
    const viewerVisible = await readableNodeIdSet(viewer, WS);
    expect(viewerVisible.has(deepLeafId)).toBe(false);

    // The admin is in that space and DOES see it — not over-restricted.
    const adminVisible = await readableNodeIdSet(admin, WS);
    expect(adminVisible.has(deepLeafId)).toBe(true);
  });
});

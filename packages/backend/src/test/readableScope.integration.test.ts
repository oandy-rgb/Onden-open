// P2 keystone: readableScopeSql (the push-down WHERE predicate) must select
// EXACTLY the same node ids as readableNodeIdSet (the materialized-set + after-
// the-fact .filter() it replaces). If these ever diverge, migrating call sites
// to the predicate would silently change who can read what — so this equivalence
// is the gate that lets the 39-site migration be mechanical and safe.
//
// Covers every branch of the space rule (membership ∩ token ∩
// external_ai): human members · token of an agent in several spaces · in one space · in none ·
// anonymous, plus a child that follows its parent into an admin-only space.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { pool, q, getWorkspaceId } from "../db.js";
import { readableNodeIdSet, readableScopeSql } from "../services/readPolicy.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// The predicate is a filter on rows the caller already confined to the
// workspace's live nodes; compare it on that same domain.
async function viaPredicate(actor: ActorCtx | null, ws: string): Promise<string[]> {
  const params: unknown[] = [ws];
  const scope = readableScopeSql(actor, "n", params);
  const res = await pool.query<{ id: string }>(
    `SELECT n.id FROM content_nodes n WHERE n.workspace_id = $1 AND n.deleted_at IS NULL AND ${scope}`,
    params,
  );
  return res.rows.map((r) => r.id).sort();
}

describe.skipIf(!isTestDb)("readableScopeSql ≡ readableNodeIdSet (DB)", () => {
  const stamp = Date.now();
  let WS = "";
  let publicId = "";       // default space → every member
  let restrictedId = "";   // admin-only space
  let childId = "";        // child of restrictedId → same space
  let scopedId = "";       // in a shared space the agent belongs to
  let scopedSpace = "";
  const actors: Record<string, ActorCtx> = {};

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id=$1 AND slug LIKE 'rs-%'`, [WS]);

    for (const role of ["viewer", "admin", "editor"]) {
      actors[role] = await persistActor(WS, { id: "", name: `rs-${role}`, role, type: "human" });
    }
    // A token reaches its agent's space memberships: three agents stand for
    // "all its spaces" (default + scopedSpace), "one space" and "none".
    const agentAll = await persistActor(WS, { id: "", name: "rs-bot-all", role: "editor", type: "agent" });
    const agentOne = await persistActor(WS, { id: "", name: "rs-bot-one", role: "editor", type: "agent" });
    const agentNone = await persistActor(WS, { id: "", name: "rs-bot-none", role: "editor", type: "agent" });
    await q(`DELETE FROM space_members WHERE actor_id = ANY($1::uuid[])`, [[agentOne.id, agentNone.id]]);
    scopedSpace = await makeSpace(WS, `rs-scope-${stamp}`,
      [{ id: agentAll.id, permission: "edit" }, { id: agentOne.id, permission: "edit" }]);
    const tok = (agent: ActorCtx): ActorCtx =>
      ({ ...agent, tokenScope: { tokenId: "rs-tok", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null } });
    actors.tokenAll = tok(agentAll);
    actors.tokenOne = tok(agentOne);
    actors.tokenEmpty = tok(agentNone);
    const secret = await adminOnlySpace(WS, `rs-secret-${stamp}`, [actors.admin!.id]);

    publicId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','rs pub ${stamp}','rs-pub-${stamp}','x') RETURNING id`, [WS])).rows[0]!.id;
    restrictedId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','rs secret ${stamp}','rs-secret-node-${stamp}','x') RETURNING id`, [WS])).rows[0]!.id;
    childId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1,'manual','content','rs child ${stamp}','rs-child-${stamp}','x',$2) RETURNING id`, [WS, restrictedId])).rows[0]!.id;
    await putInSpace(restrictedId, secret);
    scopedId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','rs scoped ${stamp}','rs-scoped-${stamp}','x') RETURNING id`, [WS])).rows[0]!.id;
    await putInSpace(scopedId, scopedSpace);
  });

  // Thunks: actors must be built INSIDE the test (after beforeAll seeds the tag
  // ids), not at describe-registration time when scopeTagId is still "".
  const cases = (): Array<[string, () => ActorCtx | null]> => [
    ["anonymous", () => null],
    ["viewer", () => actors.viewer!],
    ["admin", () => actors.admin!],
    ["editor", () => actors.editor!],
    ["token (all its spaces)", () => actors.tokenAll!],
    ["token (agent in one space)", () => actors.tokenOne!],
    ["token (agent in no space)", () => actors.tokenEmpty!],
  ];

  for (const [name, actorFn] of cases()) {
    it(`predicate ≡ set for ${name}`, async () => {
      const actor = actorFn();
      const viaSet = [...(await readableNodeIdSet(actor, WS))].sort();
      const viaSql = await viaPredicate(actor, WS);
      expect(viaSql).toEqual(viaSet);
    });
  }

  // Sanity anchors so the equivalence isn't trivially "both empty/both all".
  it("restricted node + its child hidden from viewer, visible to admin; token sees only its spaces", async () => {
    const viewer = new Set(await readableNodeIdSet(actors.viewer!, WS));
    const admin = new Set(await readableNodeIdSet(actors.admin!, WS));
    expect(viewer.has(publicId)).toBe(true);
    expect(viewer.has(restrictedId)).toBe(false);
    expect(viewer.has(childId)).toBe(false);
    expect(admin.has(restrictedId)).toBe(true);
    expect(admin.has(childId)).toBe(true);
    const one = new Set(await readableNodeIdSet(actors.tokenOne!, WS));
    expect(one.has(scopedId)).toBe(true);
    expect(one.has(publicId)).toBe(false);
    const all = new Set(await readableNodeIdSet(actors.tokenAll!, WS));
    expect(all.has(scopedId) && all.has(publicId)).toBe(true);
    expect(all.has(restrictedId)).toBe(false);
  });
});

// membership_epoch bump invariant (docs/architecture/membership-and-permission-
// epoch.md §3/§6/§8). TWO-SIDED, by design:
//   POSITIVE — every mutation that can move readableNodeIdSet() MUST bump the
//              workspace epoch (a missed bump = silent stale membership).
//   NEGATIVE — an ordinary content/title/field edit MUST NOT bump (an over-bump
//              degrades to full-set reconciliation on every keystroke = perf death).
// Bump is DECLARED by the mutation (mutate affectsMembership) and runs in the
// SAME tx via q() — never inferred from the event type.
// Spaces model (docs/architecture/spaces.md): the readable set is decided by
// space membership, so space membership changes and space moves bump; tags
// and the workspace role carry no read permission, so tagging and a role
// change must NOT bump.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, withTransaction, bumpMembershipEpoch } from "../db.js";
import { subscribeRealtime } from "../services/realtime.js";
import nodesRouter from "../routes/nodes.js";
import tagsRouter from "../routes/tags.js";
import actorsRouter from "../routes/actors.js";
import spacesRouter from "../routes/spaces.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A human admin with NO token scope = a principal (satisfies principal_admin).
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/actors", actorsRouter);
app.route("/api/spaces", spacesRouter);

const J = { "content-type": "application/json" };
const req = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...J, ...(init.headers ?? {}) } });

async function epoch(): Promise<number> {
  const r = await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE slug = 'default'`);
  return Number(r.rows[0]!.e);
}

/** Assert `fn` bumps the epoch (positive) or leaves it unchanged (negative). */
async function expectBump(fn: () => Promise<Response> | Response, shouldBump: boolean, label: string) {
  const before = await epoch();
  const res = await fn();
  expect([200, 201], `${label} status`).toContain(res.status);
  const after = await epoch();
  if (shouldBump) expect(after, `${label} MUST bump`).toBeGreaterThan(before);
  else expect(after, `${label} must NOT bump`).toBe(before);
}

describe.skipIf(!isTestDb)("membership_epoch bump invariant (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let topId = "";       // a top-level node to reparent
  let parentId = "";    // a target parent
  let taggee = "";      // node to apply/remove a tag on
  let tagId = "";       // a class_tag with a schema
  let actorId = "";     // an actor to rename / add to a space
  let spaceId = "";     // a shared space the owner manages

  const mkNode = async (title: string, slug: string): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
       VALUES ($1,'manual','content',$2,$3,'body',false,0) RETURNING id`, [WS, title, slug])).rows[0]!.id;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    topId = await mkNode(`me top ${stamp}`, `me-top-${stamp}`);
    parentId = await mkNode(`me parent ${stamp}`, `me-parent-${stamp}`);
    taggee = await mkNode(`me taggee ${stamp}`, `me-taggee-${stamp}`);
    tagId = (await seedClassTag(WS, {
      name: `me-tag-${stamp}`,
      slug: `me-tag-${stamp}`,
      nodeSlug: `me-tag-slug-${stamp}`,
    })).tagId;
    actorId = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,'human') RETURNING id`,
      [WS, `me-actor-${stamp}`])).rows[0]!.id;
    currentActor = await persistActor(WS, { id: "me-admin", name: "Admin", role: "admin", type: "human" });
    spaceId = await makeSpace(WS, `me-space-${stamp}`, [{ id: currentActor.id, permission: "edit" }]);
  });

  // ── POSITIVE: these move the readable set → MUST bump ──────────────────────
  // A reparent stays inside the note's space (a parent in another space is
  // refused), so it moves nobody's readable set.
  it("reparent does not bump", () =>
    expectBump(() => req(`/api/nodes/${topId}`, { method: "PATCH", body: JSON.stringify({ parent_id: parentId }) }), false, "reparent"));

  it("adding a space member bumps", () =>
    expectBump(() => req(`/api/spaces/${spaceId}/members/${actorId}`, { method: "PUT", body: JSON.stringify({ permission: "view" }) }), true, "space member add"));

  it("removing a space member bumps", () =>
    expectBump(() => req(`/api/spaces/${spaceId}/members/${actorId}`, { method: "DELETE" }), true, "space member remove"));

  // SUSPECTED PRODUCT BUG: a token only reads spaces whose external_ai switch
  // is on (spine/spaceScope.ts readableSpaceIdsSql), so flipping it moves
  // every token's readable set — but updateSpace (services/spaces.ts) does not
  // declare affectsMembership, so no bump. Pinned as failing until fixed.
  it("turning a space's external_ai switch off bumps (it moves what tokens read)", () =>
    expectBump(() => req(`/api/spaces/${spaceId}`, { method: "PATCH", body: JSON.stringify({ capabilities: { external_ai: false } }) }), true, "external_ai off"));

  // ── NEGATIVE: ordinary edits → MUST NOT bump ───────────────────────────────
  // Tags carry no permission under spaces: tagging never moves the readable set.
  it("tag apply does NOT bump", () =>
    expectBump(() => req(`/api/nodes/${taggee}/tags/${tagId}`, { method: "PUT", body: "{}" }), false, "tag apply"));

  it("tag remove does NOT bump", () =>
    expectBump(() => req(`/api/nodes/${taggee}/tags/${tagId}`, { method: "DELETE" }), false, "tag remove"));

  // There is no workspace role any more: a request that still carries one is
  // refused (400 role_removed) and so leaves the readable set alone.
  it("a refused actor ROLE change does NOT bump", async () => {
    const before = await epoch();
    const res = await req(`/api/actors/${actorId}`, { method: "PATCH", body: JSON.stringify({ role: "viewer" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "role_removed" });
    expect(await epoch(), "actor role refused must NOT bump").toBe(before);
  });

  it("a plain body edit does NOT bump", () =>
    expectBump(() => req(`/api/nodes/${parentId}`, { method: "PATCH", body: JSON.stringify({ markdown: "edited body " + Math.random() }) }), false, "body edit"));

  it("a tag FIELDS-only schema change does NOT bump", () =>
    expectBump(() => req(`/api/tags/${tagId}/schema`, { method: "PATCH", body: JSON.stringify({ fields: [{ key: "k" + Math.floor(Math.random() * 1e6), label: "K", type: "text" }] }) }), false, "schema fields-only"));

  it("an actor NAME-only change does NOT bump", () =>
    expectBump(() => req(`/api/actors/${actorId}`, { method: "PATCH", body: JSON.stringify({ name: "renamed " + Math.random() }) }), false, "actor name-only"));

  // Re-PATCHing the SAME parent is a no-op move → must NOT bump (guard is
  // "parent actually changed", not "a NODE_UPDATED happened").
  it("re-setting the SAME parent does NOT bump", () =>
    expectBump(() => req(`/api/nodes/${topId}`, { method: "PATCH", body: JSON.stringify({ parent_id: parentId }) }), false, "same-parent re-set"));

  // The SSE side: a committed bump fires a membership_changed tick (post-commit,
  // coalesced); a rolled-back bump fires NOTHING (afterCommit only runs on commit).
  it("bumpMembershipEpoch fires membership_changed AFTER commit; a rollback fires none", async () => {
    const ticks: number[] = [];
    const unsub = subscribeRealtime((t) => { if (t.kind === "membership_changed") ticks.push(t.epoch); });
    try {
      await withTransaction(async () => { await bumpMembershipEpoch(WS); });
      await new Promise((r) => setTimeout(r, 320)); // wait past the ~250ms coalesce flush
      expect(ticks.length).toBeGreaterThanOrEqual(1); // committed → tick fired
      const afterCommitCount = ticks.length;

      await withTransaction(async () => {
        await bumpMembershipEpoch(WS);
        throw new Error("force rollback");
      }).catch(() => { /* expected */ });
      await new Promise((r) => setTimeout(r, 320));
      expect(ticks.length).toBe(afterCommitCount); // rolled back → NO new tick
    } finally {
      unsub();
    }
  });
});

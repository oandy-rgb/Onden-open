// D9 publish opt-in (P0) against a real Postgres. The site is a space's notes
// (owner 2026-11-10), each note keeping itself off with `_published` 'false'
// (「不發布」); this workspace's default space publishes. The anonymous-
// reachable GET /api/site serves the latest snapshot minus takedowns (W38a):
// nothing before the first publish, even opted in; and a stored snapshot is
// re-filtered (a point-in-time snapshot, or one taken before opt-in existed,
// must NOT keep leaking; un-publishing takes effect on the next read, not the
// next republish).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api", publishRouter);

// Its own workspace: reset empties it, and other files share 'default'.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
const reset = async () => {
  await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
  await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);
};
const mkNode = async (title: string) =>
  (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [WS, title, `${title.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, `body of ${title}`],
  )).rows[0]!.id;
const publish = (id: string) =>
  seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
     VALUES ($1,$2,'_published','true','bool','explicit')
     ON CONFLICT (node_id, key) DO UPDATE SET value='true'`, [WS, id]);
const unpublish = (id: string) =>
  seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
     VALUES ($1,$2,'_published','false','bool','explicit')
     ON CONFLICT (node_id, key) DO UPDATE SET value='false'`, [WS, id]);
const insertSnapshot = (payload: Record<string, unknown>) =>
  q(`INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref)
     VALUES ($1,'Snap',$2,0,$3::jsonb,'/site/')`,
    [WS, (payload.home_node_id as string) ?? null, JSON.stringify(payload)]);
const site = async () => {
  const r = await app.request("/api/site");
  expect(r.status).toBe(200);
  return (await r.json()).payload ?? {};
};
const ids = (p: { nodes?: Array<{ id: string }> }) => (p.nodes ?? []).map((n) => n.id);

describe.skipIf(!isTestDb)("publish opt-in / D9 (DB)", () => {
  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Publish opt-in', $1) RETURNING id`, [randomUUID()],
    )).rows[0]!.id;
    await publishDefaultSpace(WS);
  });

  it("a site never published serves nothing, even an opted-in note", async () => {
    await reset();
    const pub = await mkNode("Public Note");
    await mkNode("Private Note");
    expect(ids(await site())).toEqual([]);
    await publish(pub);
    expect(ids(await site())).toEqual([]); // marked: public at the first Publish
  });

  it("a stored snapshot is re-filtered at serve time (old/broad snapshot can't leak)", async () => {
    await reset();
    const pub = await mkNode("Pub");
    const priv = await mkNode("Priv");
    const pub2 = await mkNode("Pub2");
    await publish(pub); await publish(pub2); await unpublish(priv); // priv is kept off
    // Simulate a snapshot taken when EVERYTHING was captured (pre-opt-in):
    await insertSnapshot({
      nodes: [{ id: pub }, { id: priv }, { id: pub2 }],
      edges: [
        { id: "e1", source_node_id: pub, target_node_id: priv },   // → should drop (priv private)
        { id: "e2", source_node_id: pub, target_node_id: pub2 },    // → kept (both public)
      ],
      home_node_id: priv, // points at a private node → must fall back
    });

    const p = await site();
    expect(ids(p).sort()).toEqual([pub, pub2].sort());          // priv filtered out
    expect((p.edges ?? []).map((e: { id: string }) => e.id)).toEqual(["e2"]); // only both-public edge
    expect(p.home_node_id).not.toBe(priv);                       // home fell back off the private node
    expect([pub, pub2]).toContain(p.home_node_id);
  });

  it("un-publishing removes a node from the served site immediately (snapshot present)", async () => {
    await reset();
    const pub = await mkNode("Will Unpublish");
    await publish(pub);
    await insertSnapshot({ nodes: [{ id: pub }], edges: [], home_node_id: pub });
    expect(ids(await site())).toContain(pub);   // published → visible

    await unpublish(pub);
    expect(ids(await site())).not.toContain(pub); // toggled private → gone on next read, no republish needed
  });
});

// Audit 2026-06-10 #1 regression — bulk read endpoints must apply the
// COMBINED read set (role/tag-policy visibility ∩ bearer-token tag scope),
// not token scope alone. Before the fix, a low-role HUMAN could bypass a
// tag's read policy entirely: /api/query returned restricted titles,
// /api/sync handed out full node rows, /api/events leaked payloads.
//
// Seed (spaces model, docs/architecture/spaces.md): a node in an admin-only
// space + a node in the default space. Pin: the viewer sees only the default-
// space one on query/sync/events; the admin sees both.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import queryRouter from "../routes/query.js";
import syncRouter from "../routes/sync.js";
import eventsRouter from "../routes/events.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/query", queryRouter);
app.route("/api/sync", syncRouter);
app.route("/api/events", eventsRouter);

let viewer: ActorCtx = { id: "rp-viewer", name: "Viewer", role: "viewer", type: "human" };
let admin: ActorCtx = { id: "rp-admin", name: "Admin", role: "admin", type: "human" };

describe.skipIf(!isTestDb)("role read-policy on bulk endpoints (DB)", () => {
  let WS = "";
  let secretId = "";
  let publicId = "";
  let stamp = 0; // unique per-run token in both seeded titles — used to scope the query test off shared-DB volume
  let sinceId = "0"; // event-id watermark — the shared test DB has other tests' events; sync LIMITs at 500

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    viewer = await persistActor(WS, viewer);
    admin = await persistActor(WS, admin);
    stamp = Date.now();

    // An admin-only space (was: an admin-read class tag).
    const secretSpace = await adminOnlySpace(WS, `rp-secret-${stamp}`, [admin.id]);

    const secret = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Restricted salary data ${stamp}','rp-secret-node-${stamp}','TOP SECRET BODY') RETURNING id`,
      [WS]);
    secretId = secret.rows[0]!.id;
    await putInSpace(secretId, secretSpace);

    const pub = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Public note ${stamp}','rp-public-${stamp}','hello') RETURNING id`,
      [WS]);
    publicId = pub.rows[0]!.id;

    // Node-targeted events (sync deltas are event-driven — a node enters the
    // upsert set only via its events). The restricted one's payload carries
    // its title, the exact leak the events feed must now stop.
    sinceId = (await q<{ max: string }>(`SELECT COALESCE(MAX(id),0)::text AS max FROM domain_events`)).rows[0]!.max;
    await event(WS, "NODE_UPDATED", "node", secretId, { title: `Restricted salary data ${stamp}` }, "user", "rp-someone");
    await event(WS, "NODE_UPDATED", "node", publicId, { title: `Public note ${stamp}` }, "user", "rp-someone");
  });

  it("query: a viewer's hits exclude policy-restricted nodes; an admin's include them", async () => {
    // Scope the query to THIS run's two seeded nodes (both titles carry `stamp`).
    // /api/query returns an ORDER BY ... LIMIT 50 window; on the shared test DB,
    // hundreds of other tests' nodes would otherwise push the seeded pair out of
    // that window and flake this assertion. The read-policy predicate under test
    // applies inside the same WHERE, so narrowing the candidate set doesn't weaken
    // it — the secret must still be excluded for the viewer among the matches.
    const run = async () => (await (await app.request("/api/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ where: { title: { op: "contains", value: String(stamp) } } }),
    })).json()).rows as Array<{ id: string }>;

    currentActor = viewer;
    const viewerRows = await run();
    expect(viewerRows.some((r) => r.id === publicId)).toBe(true);
    expect(viewerRows.some((r) => r.id === secretId)).toBe(false);

    currentActor = admin;
    const adminRows = await run();
    expect(adminRows.some((r) => r.id === secretId)).toBe(true);
  });

  it("sync: a viewer's delta carries no restricted node rows", async () => {
    const run = async () => (await (await app.request(`/api/sync?since=${sinceId}`)).json()) as {
      nodes: { upsert: Array<{ id: string }> };
    };

    currentActor = viewer;
    const v = await run();
    expect(v.nodes.upsert.some((n) => n.id === secretId)).toBe(false);
    expect(v.nodes.upsert.some((n) => n.id === publicId)).toBe(true);

    currentActor = admin;
    const a = await run();
    expect(a.nodes.upsert.some((n) => n.id === secretId)).toBe(true);
  });

  it("events: a viewer's feed excludes node events about restricted nodes", async () => {
    const run = async () => (await (await app.request(`/api/events?target_id=${secretId}`)).json()).events as Array<{ target_id: string }>;

    currentActor = viewer;
    expect((await run()).length).toBe(0);

    currentActor = admin;
    expect((await run()).length).toBeGreaterThan(0);
  });
});

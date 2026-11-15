// Scale / large-data verification (大量資料) against a real Postgres. Seeds
// thousands of nodes + events, then guards the two scale properties that
// actually bite: (1) the bootstrap per-node event lookup is INDEX-backed (the
// 055 fix — without it /api/bootstrap full-scans domain_events once per node,
// ~10.4s at 3k/9k vs ~36ms with the index), and (2) the event feed's pagination
// cap holds no matter how much data exists (no unbounded result set).
//
// SAFETY: only runs against a *_test database; skips otherwise.
//   DATABASE_URL=postgres://.../onden_test npx vitest run src/test/scale.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import eventsRouter from "../routes/events.js";
import type { ActorCtx } from "../types.js";
import { nativeOwnerActor } from "./helpers/persistActor.js";
import { needsPostgresServer } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

// A workspace of its own: the seeded thousands must neither wipe nor swell the
// shared default workspace other tests read (the events route reads it).
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/events", eventsRouter);

const NODES = 1500;
const EVENTS_PER = 3;

describe.skipIf(!isTestDb || needsPostgresServer)("scale / large data (DB)", () => {
  let sampleNodeId: string;

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Scale', $1) RETURNING id`, [`scale-${randomUUID()}`],
    );
    workspaceId = ws.rows[0]!.id;
    // Bulk-seed nodes + a few events each via generate_series (fast).
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, sort_order)
       SELECT $1,'manual','content','Node '||g,'scale-node-'||g,'body '||g, g
       FROM generate_series(1,$2) g`,
      [workspaceId, NODES],
    );
    await q(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at)
       SELECT $1,'user','seed','NODE_UPDATED','content_node', n.id::text, '{}'::jsonb, now() - (s||' minutes')::interval
       FROM content_nodes n, generate_series(1,$2) s
       WHERE n.workspace_id = $1 AND n.slug LIKE 'scale-node-%'`,
      [workspaceId, EVENTS_PER],
    );
    sampleNodeId = (await q<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id=$1 AND slug LIKE 'scale-node-%' LIMIT 1`,
      [workspaceId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [workspaceId]);
  });

  // The 055 fix: the exact per-node bootstrap subquery shape must use the
  // target index, not a seq scan. This is what keeps bootstrap from going
  // O(nodes × events).
  it("the per-target event lookup is index-backed (no seq scan)", async () => {
    const plan = (await q<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT actor_id FROM domain_events
        WHERE target_type='content_node' AND target_id=$1
        ORDER BY created_at DESC LIMIT 1`,
      [sampleNodeId],
    )).rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("domain_events_target_idx");
    expect(plan).not.toContain("Seq Scan on domain_events");
  });

  // Pagination cap holds regardless of volume — an over-large limit can't pull
  // an unbounded result set.
  it("event feed caps the result set even with a huge limit", async () => {
    // The owner sees every event (services/eventVisibility.ts), so the cap is
    // what bounds the page.
    currentActor = await nativeOwnerActor(workspaceId);
    const res = await app.request("/api/events?limit=99999");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.length).toBeLessThanOrEqual(500); // hard cap from buildEventQuery
    expect(body.events.length).toBeGreaterThan(100);      // and we really did seed a lot
  });
});

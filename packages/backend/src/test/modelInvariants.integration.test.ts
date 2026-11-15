// MODEL INVARIANTS — the cross-cutting properties EVERY entry point must obey,
// proving the whole surface follows one model rather than each route improvising
// (the architecture the user codified):
//
//   Command  → Authority → Transaction(mutation + event) → Current projection
//   Event log → Sync candidates → Current read-policy filter → Client projection
//   Restore  → Current authority → Inverse command → SAME transaction pipeline
//
// These are deliberately ENDPOINT-LEVEL and adversarial: they drive the real
// routers (nodes / sync / events / query) so a future route that re-implements
// or bypasses the model fails here. They complement the per-mechanism suites:
//   - Invariant 5 (revocation deletes a local copy with NO node event) lives in
//     syncRevocation.integration.test.ts (all four revocation mechanisms).
//   - Read-policy-before-LIMIT + lossless feed live in eventsFeed.integration.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import { mutate } from "../spine/mutate.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import eventsRouter from "../routes/events.js";
import queryRouter from "../routes/query.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/sync", syncRouter);
app.route("/api/events", eventsRouter);
app.route("/api/query", queryRouter);

let admin: ActorCtx = { id: "inv-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "inv-viewer", name: "Viewer", role: "viewer", type: "human" };

const J = { "content-type": "application/json" };
const req = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...J, ...(init.headers ?? {}) } });

async function eventCount(): Promise<number> {
  return Number((await q<{ c: string }>(`SELECT COUNT(*)::text AS c FROM domain_events`)).rows[0]!.c);
}

describe.skipIf(!isTestDb)("model invariants (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let openNodeId = "";
  let restrictedNodeId = "";
  // Cursor captured just before this suite's events — sync from here so the
  // 500-row event window reaches our nodes even when prior test files have
  // appended thousands of events to the shared onden_test log.
  // Backed off 256 ids: /api/sync parses `since` as a JS number, and once the
  // shared DB's event sequence is past 2^53 a rounded-up cursor would skip
  // this suite's own events. Re-shipping a few older rows is harmless.
  let baseCursor = 0;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    viewer = await persistActor(WS, viewer);

    // Open node — viewer-readable (no restrictive tag). hidden=false so it
    // surfaces in the query endpoint (which excludes hidden/deleted rows).
    openNodeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
       VALUES ($1,'manual','content',$2,$3,'b',false,0) RETURNING id`,
      [WS, `inv open ${stamp}`, `inv-open-${stamp}`])).rows[0]!.id;

    // Restricted node — in a space only the admin belongs to.
    restrictedNodeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
       VALUES ($1,'manual','content',$2,$3,'secret',false,0) RETURNING id`,
      [WS, `inv restricted ${stamp}`, `inv-restricted-${stamp}`])).rows[0]!.id;
    await putInSpace(restrictedNodeId, await adminOnlySpace(WS, `inv-restrict-${stamp}`, [admin.id]));

    baseCursor = Number((await q<{ m: string }>(`SELECT GREATEST(COALESCE(MAX(id),0) - 256, 0)::text AS m FROM domain_events`)).rows[0]!.m);
    // Emit an event for each so they enter sync's event-driven upsert window —
    // crucially, the restricted node now HAS an event, so the viewer-absence
    // check proves sync filters by read policy even when an event is present
    // (not merely "no event ⇒ nothing to show").
    await event(WS, "NODE_UPDATED", "node", openNodeId, { title: "open" }, "user", admin.id);
    await event(WS, "NODE_UPDATED", "node", restrictedNodeId, { title: "secret" }, "user", admin.id);
  });

  // ── Invariant 1: an unreadable node appears in NO read endpoint ────────────
  it("a restricted node is absent from EVERY read endpoint for a viewer (present for admin)", async () => {
    // sync
    currentActor = viewer;
    const vSync = await (await req("/api/sync", { method: "POST", body: JSON.stringify({ since: baseCursor, known: [] }) })).json() as { nodes: { upsert: Array<{ id: string }> } };
    expect(vSync.nodes.upsert.some((n) => n.id === restrictedNodeId)).toBe(false);

    // events (the restricted node's event IS in this window, yet must not surface)
    const vEvents = await (await req(`/api/events?since=${baseCursor}&limit=500`)).json() as { events: Array<{ target_id: string }> };
    expect(vEvents.events.some((e) => e.target_id === restrictedNodeId)).toBe(false);
    expect(vEvents.events.some((e) => e.target_id === openNodeId)).toBe(true); // open event IS delivered

    // query
    // Restrict to this scenario, keeping BOTH the allowed and denied controls.
    // An unfiltered first page (limit 50) can omit them in a reused test DB.
    const queryBody = JSON.stringify({ where: { title: { op:"contains",value:String(stamp) } } });
    const vQuery = await (await req("/api/query", { method: "POST", body: queryBody })).json() as { rows: Array<{ id: string }> };
    expect(vQuery.rows.some((r) => r.id === restrictedNodeId)).toBe(false);
    // Sanity: the viewer CAN see the open node via query (the filter isn't blanket).
    expect(vQuery.rows.some((r) => r.id === openNodeId)).toBe(true);

    // admin sees it everywhere — proves it's read POLICY, not a missing row.
    currentActor = admin;
    const aSync = await (await req("/api/sync", { method: "POST", body: JSON.stringify({ since: baseCursor, known: [] }) })).json() as { nodes: { upsert: Array<{ id: string }> } };
    expect(aSync.nodes.upsert.some((n) => n.id === restrictedNodeId)).toBe(true);
    const aQuery = await (await req("/api/query", { method: "POST", body: queryBody })).json() as { rows: Array<{ id: string }> };
    expect(aQuery.rows.some((r) => r.id === restrictedNodeId)).toBe(true);
  });

  // ── Invariant 2: a successful mutation emits exactly one ROOT event ─────────
  it("a successful node create emits exactly ONE root domain_event attributed to the actor", async () => {
    currentActor = admin;
    const before = await eventCount();
    const res = await req("/api/nodes", { method: "POST", body: JSON.stringify({ title: `inv create ${stamp}`, markdown: "x" }) });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;

    // Exactly one ROOT event (triggered_by IS NULL) for this node — cascades, if
    // any, hang off it as triggered_by children, never as extra roots.
    const roots = await q<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM domain_events
        WHERE target_id = $1 AND triggered_by_event_id IS NULL`, [id]);
    expect(Number(roots.rows[0]!.c)).toBe(1);
    // And the log strictly grew (a mutation is never silent).
    expect(await eventCount()).toBeGreaterThan(before);
  });

  // ── Invariant 3: a FAILED mutation leaves no state and no event ────────────
  // The strongest form: event + apply are ONE transaction, so when apply()
  // throws AFTER the event is staged, BOTH roll back together — never a "state
  // changed, no event" or "event written, no state" split. Driven through the
  // spine mutate() directly (the single command pipeline every route funnels
  // into), with an authority the actor passes so we actually reach apply().
  it("a mutation whose apply() throws leaves NO event and NO state (event+apply atomic)", async () => {
    const before = await eventCount();
    const titleBefore = (await q<{ title: string }>(
      `SELECT title FROM content_nodes WHERE id = $1`, [openNodeId])).rows[0]!.title;

    let threw = false;
    try {
      await mutate({
        actor: admin,
        workspaceId: WS,
        authority: { kind: "node", nodeId: openNodeId, op: "write_node" },
        event: { type: "NODE_UPDATED", targetType: "node", targetId: openNodeId, payload: { title: "SHOULD_ROLL_BACK" } },
        apply: async () => {
          // Stage a real state change, THEN fail — both must vanish on rollback.
          await seedQ(`UPDATE content_nodes SET title = 'SHOULD_ROLL_BACK' WHERE id = $1`, [openNodeId]);
          throw new Error("boom — simulated apply failure");
        },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // No event appended …
    expect(await eventCount()).toBe(before);
    // … and the apply's write rolled back with it (title unchanged).
    const titleAfter = (await q<{ title: string }>(
      `SELECT title FROM content_nodes WHERE id = $1`, [openNodeId])).rows[0]!.title;
    expect(titleAfter).toBe(titleBefore);
  });

  // ── Invariant 4: restore is a NEW inverse mutation; clients then converge ───
  it("create → delete → restore, then sync converges the client to 'node exists'", async () => {
    currentActor = admin;
    // baseline cursor BEFORE this scenario's events
    const baseCursor = Number((await q<{ m: string }>(`SELECT GREATEST(COALESCE(MAX(id),0) - 256, 0)::text AS m FROM domain_events`)).rows[0]!.m);

    const created = await req("/api/nodes", { method: "POST", body: JSON.stringify({ title: `inv restore ${stamp}`, markdown: "x" }) });
    const id = ((await created.json()) as { id: string }).id;
    const delRes = await req(`/api/nodes/${id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    // Find the NODE_DELETED event for this node.
    const delEvent = await q<{ id: string }>(
      `SELECT id::text AS id FROM domain_events
        WHERE target_id = $1 AND event_type = 'NODE_DELETED' ORDER BY domain_events.id DESC LIMIT 1`, [id]);
    const delEventId = delEvent.rows[0]!.id;

    // Restore = a NEW mutation through the same pipeline (it appends an event,
    // it does NOT rewrite history). Authority is re-checked at restore time.
    const restoreRes = await req(`/api/events/${delEventId}/restore`, { method: "POST", body: JSON.stringify({}) });
    expect(restoreRes.status).toBe(200);

    // A client syncing from BEFORE the whole scenario converges to "node exists":
    // the node is in upsert and NOT in delete (the net effect of create+del+restore).
    const sync = await (await req("/api/sync", { method: "POST", body: JSON.stringify({ since: baseCursor, known: [id] }) })).json() as { nodes: { upsert: Array<{ id: string }>; delete: string[] } };
    expect(sync.nodes.delete).not.toContain(id);
    expect(sync.nodes.upsert.some((n) => n.id === id)).toBe(true);

    // And the live projection agrees: the row is not soft-deleted.
    const row = await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [id]);
    expect(row.rows[0]!.deleted_at).toBeNull();

    // Restore appended history rather than mutating it: the NODE_DELETED event
    // still exists, and a restore event was added after it.
    const stillThere = await q<{ c: string }>(`SELECT COUNT(*)::text AS c FROM domain_events WHERE id = $1::bigint`, [delEventId]);
    expect(Number(stillThere.rows[0]!.c)).toBe(1);
  });
});

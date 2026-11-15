// GET /api/events — two correctness properties that only show up against a real
// event log (and so were never caught: the DB-gated suite skips without a
// *_test DB):
//
//   Finding 1 — LOSSLESS FORWARD DRAIN. A burst larger than one page must not be
//   skipped. The endpoint returns events AFTER `since` OLDEST-first (ASC); the
//   caller advances its cursor to each page's max id and pulls until a short
//   page. The old `ORDER BY id DESC` returned only the newest `limit` ids > since,
//   so once the cursor jumped to the max, everything below the window was lost.
//
//   Finding 4 — READ POLICY BEFORE LIMIT. The readable filter is folded into the
//   SQL, so a page returns `limit` READABLE rows even when the newest window is
//   mostly restricted-node events. The old post-LIMIT filter returned a
//   near-empty page in that case.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import eventsRouter from "../routes/events.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/events", eventsRouter);

let admin: ActorCtx = { id: "ef-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "ef-viewer", name: "Viewer", role: "viewer", type: "human" };

// Event ids are compared as BigInt: the shared test DB's domain_events
// sequence can sit above 2^53 (another suite probes that boundary), where
// Number() collapses neighbouring ids.
type Ev = { id: bigint; target_type: string; target_id: string; event_type: string };
async function getEvents(params: Record<string, string>): Promise<Ev[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/events?${qs}`);
  expect(res.status, "GET /api/events").toBe(200);
  // pg serialises bigint `id` as a string — coerce so numeric comparisons hold.
  return ((await res.json()) as { events: Ev[] }).events.map((e) => ({ ...e, id: BigInt(e.id) }));
}

describe.skipIf(!isTestDb)("GET /api/events feed (findings 1 & 4) (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let openNodeId = "";        // readable by everyone (default space)
  let restrictedNodeId = "";  // admin-only space
  const burstIds: bigint[] = [];

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    viewer = await persistActor(WS, viewer);
    // Isolate this suite's window: start the cursor at the current head so prior
    // fixtures from other files don't bleed into the assertions.
    const head0 = BigInt((await q<{ max: string }>(`SELECT COALESCE(MAX(id),0)::text AS max FROM domain_events`)).rows[0]!.max);

    // An OPEN node (viewer-readable: in the default space).
    openNodeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'b') RETURNING id`,
      [WS, `ef open ${stamp}`, `ef-open-${stamp}`])).rows[0]!.id;

    // A RESTRICTED node: in an admin-only space the viewer is not in.
    const secretSpace = await adminOnlySpace(WS, `ef-restrict-${stamp}`, [admin.id]);
    restrictedNodeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'b') RETURNING id`,
      [WS, `ef restricted ${stamp}`, `ef-restricted-${stamp}`])).rows[0]!.id;
    await putInSpace(restrictedNodeId, secretSpace);

    // (Finding 1) A burst of OPEN-node events, larger than the page size used
    // below (limit=20 → emit 50). Record their ids in order.
    for (let i = 0; i < 50; i++) {
      const id = await event(WS, "NODE_UPDATED", "node", openNodeId, { i }, "user", admin.id);
      burstIds.push(BigInt(id));
    }

    // (Finding 4) AFTER the open burst, a wall of RESTRICTED-node events so they
    // dominate the newest window — then nothing else. A viewer's newest page
    // must still surface the open burst (filtered before limit), not come back
    // near-empty.
    for (let i = 0; i < 40; i++) {
      await event(WS, "NODE_UPDATED", "node", restrictedNodeId, { i }, "user", admin.id);
    }

    // Sanity: our fixtures sit entirely above head0.
    expect(burstIds[0]).toBeGreaterThan(head0);
  });

  it("finding 1: forward drain (ASC) returns EVERY event in a burst larger than one page", async () => {
    currentActor = admin;
    const limit = 20;
    const since0 = burstIds[0]! - 1n; // just below the first burst id
    let cursor = since0;
    const collected: bigint[] = [];
    // Mirror the client drain: ASC pages, advance cursor to max, stop on short page.
    for (let guard = 0; guard < 20; guard++) {
      const page = await getEvents({ since: String(cursor), limit: String(limit), target_id: openNodeId });
      if (page.length === 0) break;
      // ASC: ids strictly increasing within the page.
      for (let k = 1; k < page.length; k++) expect(page[k]!.id).toBeGreaterThan(page[k - 1]!.id);
      cursor = page[page.length - 1]!.id;
      collected.push(...page.map((e) => e.id));
      if (page.length < limit) break;
    }
    // All 50 burst ids recovered, in order, no gaps, no dupes.
    expect(collected).toEqual(burstIds);
  });

  it("finding 4: a viewer's newest page surfaces readable events even when the newest window is all restricted", async () => {
    currentActor = viewer;
    // Newest page, no `since` → DESC, read-filtered BEFORE limit.
    const page = await getEvents({ limit: "20" });
    const ids = new Set(page.map((e) => e.target_id));
    // The restricted node's events dominate the raw newest window but must NOT leak.
    expect(ids.has(restrictedNodeId)).toBe(false);
    // The older OPEN burst is still delivered (not a near-empty post-filter page).
    expect(ids.has(openNodeId)).toBe(true);
    expect(page.length).toBeGreaterThan(0);
  });

  it("finding 4: an admin DOES see the restricted node's events (policy, not blanket hiding)", async () => {
    currentActor = admin;
    const page = await getEvents({ limit: "20", target_id: restrictedNodeId });
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((e) => e.target_id === restrictedNodeId)).toBe(true);
  });
});

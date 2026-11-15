// GET /sync/membership — the paginated current-readable-id stream (Step B1,
// membership-and-permission-epoch.md §4). The client diffs this against its local
// set; here we prove the SERVER side: read-policy filtering, keyset pagination,
// and the snapshot's consistency signal (epoch ≠ expected → retry page so the
// client restarts).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";

// This router harness injects identity; database snapshot/policy remain real.
vi.mock("../services/actorReadSnapshot.js", () => import("./helpers/injectedActorReadSnapshot.js"));
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { createHash, randomUUID } from "node:crypto";
import { q } from "../db.js";
import syncRouter from "../routes/sync.js";
import { persistActor } from "./helpers/persistActor.js";
import { membershipDigestOf } from "../services/sync/membership.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { createTaskNode } from "../services/tasksStore.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let WS = "";
// The default workspace accumulates other suites' fixtures. With two ids per
// page the 100-page guard silently truncated that unrelated dataset. Keep this
// policy/pagination scenario isolated, including the router's workspace lookup.
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/sync", syncRouter);

const admin: ActorCtx = { id: "mep-admin", name: "Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "mep-viewer", name: "Viewer", role: "viewer", type: "human" };

type Page = { ids: string[]; next_cursor: string | null; epoch: number };
async function membership(params: Record<string, string>): Promise<Page> {
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/sync/membership?${qs}`);
  expect(res.status, "GET /sync/membership").toBe(200);
  return (await res.json()) as Page;
}

/** Drain all pages (epoch-stable), returning the full id set + the shared epoch. */
async function drainMembership(expectedEpoch: number): Promise<{ ids: Set<string>; epoch: number; restarted: boolean }> {
  let cursor = "";
  const ids = new Set<string>();
  let restarted = false;
  for (let guard = 0; guard < 100; guard++) {
    const page = await membership({ expected_epoch: String(expectedEpoch), cursor, limit: "2" });
    if (page.epoch !== expectedEpoch) { restarted = true; break; } // mismatch → client would restart
    for (const id of page.ids) ids.add(id);
    if (page.next_cursor == null) break;
    cursor = page.next_cursor;
  }
  return { ids, epoch: expectedEpoch, restarted };
}

describe.skipIf(!isTestDb)("GET /sync/membership (Step B1) (DB)", () => {
  const stamp = Date.now();
  const openIds: string[] = [];
  let restrictedId = "";

  const mkNode = async (title: string, slug: string): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'b') RETURNING id`, [WS, title, slug])).rows[0]!.id;

  const epoch = async (): Promise<number> =>
    Number((await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [WS])).rows[0]!.e);

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Membership endpoint',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(viewer, await persistActor(WS, viewer));
    // 5 viewer-readable nodes (default space).
    for (let i = 0; i < 5; i++) openIds.push(await mkNode(`mep open ${i} ${stamp}`, `mep-open-${i}-${stamp}`));
    // 1 restricted node, in a space only the admin belongs to.
    restrictedId = await mkNode(`mep restricted ${stamp}`, `mep-restricted-${stamp}`);
    await putInSpace(restrictedId, await adminOnlySpace(WS, `mep-r-${stamp}`, [admin.id]));
  });

  it("space filtered: a viewer's drained set has all open nodes, never the restricted one", async () => {
    currentActor = viewer;
    const { ids } = await drainMembership(await epoch());
    for (const id of openIds) expect(ids.has(id)).toBe(true);
    expect(ids.has(restrictedId)).toBe(false);
  });

  it("admin's drained set DOES include the restricted node (it's space membership, not a missing row)", async () => {
    currentActor = admin;
    const { ids } = await drainMembership(await epoch());
    expect(ids.has(restrictedId)).toBe(true);
  });

  it("keyset pagination: pages are ascending, non-overlapping, and cover the whole set", async () => {
    currentActor = admin;
    const e = await epoch();
    let cursor = "";
    const seen: string[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const page = await membership({ expected_epoch: String(e), cursor, limit: "2" });
      expect(page.ids.length).toBeLessThanOrEqual(2);
      for (let k = 1; k < page.ids.length; k++) expect(page.ids[k]! > page.ids[k - 1]!).toBe(true); // ascending within page
      if (cursor) for (const id of page.ids) expect(id > cursor).toBe(true); // strictly after the cursor
      seen.push(...page.ids);
      if (page.next_cursor == null) break;
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no dupes across pages
    for (const id of openIds) expect(seen).toContain(id);
  });

  it("epoch mismatch (stale expected) → empty page carrying the CURRENT epoch (client restarts)", async () => {
    currentActor = viewer;
    const current = await epoch();
    const page = await membership({ expected_epoch: String(current + 999), cursor: "", limit: "2" });
    expect(page.ids).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page.epoch).toBe(current); // tells the client the real epoch to retry with
  });

  it("POST /sync/nodes returns the FULL projection for requested ids, RE-FILTERED by space read rule", async () => {
    // Seed an attribute on an open node so we can prove the attributes CHANNEL
    // comes back (review #3 — node rows alone left local node_attributes empty).
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type)
             VALUES ($1,$2,'mep_k','mep_v','text') ON CONFLICT (node_id,key) DO UPDATE SET value=EXCLUDED.value`,
      [WS, openIds[0]]);
    currentActor = viewer;
    const res = await app.request(`/api/sync/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [openIds[0], restrictedId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ id: string }>;
      attributes: { upsert: Array<{ node_id: string; key: string }> };
      edges: unknown[]; tasks: unknown[];
    };
    const ids = new Set(body.nodes.map((n) => n.id));
    expect(ids.has(openIds[0]!)).toBe(true);     // requested + readable → returned
    expect(ids.has(restrictedId)).toBe(false);   // requested but NOT readable → withheld (defense-in-depth)
    // The attributes CHANNEL carries the open node's attribute (so the client
    // persists it), and never the restricted node's.
    expect(body.attributes.upsert.some((a) => a.node_id === openIds[0] && a.key === "mep_k")).toBe(true);
    expect(body.attributes.upsert.some((a) => a.node_id === restrictedId)).toBe(false);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.tasks)).toBe(true);
    // admin gets the restricted one.
    currentActor = admin;
    const aRes = await app.request(`/api/sync/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [restrictedId] }),
    });
    const aNodes = (await aRes.json()) as { nodes: Array<{ id: string }> };
    expect(aNodes.nodes.some((n) => n.id === restrictedId)).toBe(true);
  });

  it("POST /sync/nodes sends a task node as its task row, never its attribute rows (as bootstrap and delta do)", async () => {
    // A task on an open note (a task row needs a live host).
    const task = await createTaskNode({ workspaceId: WS, actor: admin, hostId: openIds[0]!, title: `mep task ${stamp}` });
    expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1`, [task])).rowCount).toBeGreaterThan(0);
    // An ordinary note's attribute, so the channel is shown to carry the rest (tests run in a random order).
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type)
             VALUES ($1,$2,'mep_task_k','v','text') ON CONFLICT (node_id,key) DO NOTHING`, [WS, openIds[0]]);
    currentActor = viewer;
    const res = await app.request(`/api/sync/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [task, openIds[0]] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ id: string }>; attributes: { upsert: Array<{ node_id: string }> }; tasks: Array<{ id: string }>;
    };
    expect(body.tasks.some((t) => t.id === task)).toBe(true);
    expect(body.nodes.some((n) => n.id === task)).toBe(false);
    expect(body.attributes.upsert.some((a) => a.node_id === task)).toBe(false);
    expect(body.attributes.upsert.some((a) => a.node_id === openIds[0])).toBe(true);
  });

  it("a membership change mid-reconciliation is caught: bump the epoch, a stale-expected drain restarts", async () => {
    currentActor = viewer;
    const startEpoch = await epoch();
    // Simulate a permission change landing after the client captured startEpoch.
    await q(`UPDATE workspaces SET membership_epoch = membership_epoch + 1 WHERE id = $1`, [WS]);
    const { restarted } = await drainMembership(startEpoch);
    expect(restarted).toBe(true); // the drain saw epoch ≠ expected and bailed to restart
  });

  // GET /sync/membership/digest: the digest of exactly the set the pages drain.
  it("digest: equals the hash of the drained set, per actor; a revoked note changes it and its bucket", async () => {
    const digestFor = async (who: ActorCtx) => {
      currentActor = who;
      const res = await app.request(`/api/sync/membership/digest`);
      expect(res.status).toBe(200);
      return (await res.json()) as { epoch: number; count: number; digest: string; buckets: Record<string, string> };
    };
    // A note of its own to revoke: the other tests read the shared open notes.
    const revoked = await mkNode(`mep revoked ${stamp}`, `mep-revoked-${stamp}`);
    const viewerBefore = await digestFor(viewer);
    currentActor = viewer;
    const drained = await drainMembership(await epoch());
    expect(viewerBefore).toMatchObject(membershipDigestOf(drained.ids));
    expect(viewerBefore.digest).not.toBe((await digestFor(admin)).digest); // the admin also reads the restricted note

    // Revoke one open note from the viewer: its bucket's digest changes, and a
    // page scoped to that bucket lists the bucket without it.
    await putInSpace(revoked, await adminOnlySpace(WS, `mep-r2-${stamp}`, [admin.id]));
    const viewerAfter = await digestFor(viewer);
    expect(viewerAfter.digest).not.toBe(viewerBefore.digest);
    expect(viewerAfter.count).toBe(viewerBefore.count - 1);
    const bucket = revoked.slice(0, 2);
    expect(viewerAfter.buckets[bucket]).not.toBe(viewerBefore.buckets[bucket]);
    currentActor = viewer;
    const scoped = await membership({ expected_epoch: String(viewerAfter.epoch), cursor: "", prefixes: bucket });
    expect(scoped.ids).not.toContain(revoked);
    for (const id of scoped.ids) expect(id.slice(0, 2)).toBe(bucket);
    expect(scoped.ids.length).toBe([...drained.ids].filter((id) => id !== revoked && id.slice(0, 2) === bucket).length);
  });

  // GET/POST /sync/drawings: the offline copy's drawings, read-gated.
  it("drawings: the index and the values list only notes the actor may read", async () => {
    const drawn = openIds[1]!;
    for (const id of [drawn, restrictedId]) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'ink_data','{"version":1,"strokes":[]}','text')
               ON CONFLICT (node_id,key) DO UPDATE SET value=EXCLUDED.value`, [WS, id]);
    }
    const index = async () => (await (await app.request("/api/sync/drawings")).json()) as { drawings: Array<{ node_id: string; key: string; size: number; hash: string }> };
    const values = async (ids: string[]) => (await (await app.request("/api/sync/drawings", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }),
    })).json()) as { drawings: Array<{ node_id: string; key: string; value: string }> };
    currentActor = viewer;
    const seen = await index();
    const sha = createHash("sha256").update('{"version":1,"strokes":[]}', "utf8").digest("hex");
    expect(seen.drawings).toContainEqual({ node_id: drawn, key: "ink_data", size: 26, hash: sha }); // the client hashes its copy the same way
    expect(seen.drawings.some((d) => d.node_id === restrictedId)).toBe(false);
    const got = await values([drawn, restrictedId]);
    expect(got.drawings.map((d) => d.node_id)).toEqual([drawn]);
    expect(got.drawings[0]!.value).toBe('{"version":1,"strokes":[]}');
    currentActor = admin;
    expect((await index()).drawings.some((d) => d.node_id === restrictedId)).toBe(true);
    const tooMany = await app.request("/api/sync/drawings", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: Array.from({ length: 21 }, () => crypto.randomUUID()) }) });
    expect(tooMany.status).toBe(413);
    // Ids must be UUIDs: 36 dashes reached the ::uuid[] cast (a 500).
    for (const ids of [["-".repeat(36)], ["not-a-uuid"], [7], "nope"]) {
      const res = await app.request("/api/sync/drawings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      expect(res.status, JSON.stringify(ids)).toBe(400);
    }
  });
});

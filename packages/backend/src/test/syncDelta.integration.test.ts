// buildSyncDelta's membership diff, called directly (depth audit D8): the
// security rule — readableNodeIdSet is the ONLY input to both the upsert
// filter and the revocation diff — tested without HTTP. The route tests
// (syncRevocation.integration and others) still cover the wire.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId, event } from "../db.js";
import { buildSyncDelta, MAX_KNOWN_IDS } from "../services/sync/index.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { markAsTask } from "./helpers/taskRef.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const admin: ActorCtx = { id: "delta-admin", name: "Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "delta-viewer", name: "Viewer", role: "viewer", type: "human" };

describe.skipIf(!isTestDb)("buildSyncDelta membership diff (DB, no HTTP)", () => {
  let WS = "";
  let shared = "";
  let adminOnly = "";
  let since = 0;
  const stamp = Date.now();

  async function note(title: string, space: string): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'body') RETURNING id::text`,
      [WS, title, `${title.toLowerCase().replace(/\W+/g, "-")}-${stamp}`])).rows[0]!.id;
    await putInSpace(id, space);
    return id;
  }
  const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id as string);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(viewer, await persistActor(WS, viewer));
    shared = await makeSpace(WS, `delta-shared-${stamp}`, [{ id: admin.id, role: "manager" }, { id: viewer.id, role: "viewer" }]);
    adminOnly = await makeSpace(WS, `delta-private-${stamp}`, [{ id: admin.id, role: "manager" }]);
    // Start past everything already in the log: these tests are about the
    // diff against `known`, not the event window.
    since = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
  });

  it("a held note that left the read set is deleted; a bystander in the same space is not", async () => {
    const leaving = await note(`Leaving ${stamp}`, shared);
    const staying = await note(`Staying ${stamp}`, shared);
    await putInSpace(leaving, adminOnly); // a permission change: no node event

    const delta = await buildSyncDelta(viewer, WS, { since, known: [leaving, staying] });
    expect(delta.nodes.delete).toContain(leaving);
    expect(delta.nodes.delete).not.toContain(staying);
    expect(ids(delta.nodes.upsert)).not.toContain(leaving);
  });

  it("a readable note the client doesn't hold is granted; an unreadable one is not", async () => {
    const held = await note(`Held ${stamp}`, shared);
    const granted = await note(`Granted ${stamp}`, shared);
    const hidden = await note(`Hidden ${stamp}`, adminOnly);

    const delta = await buildSyncDelta(viewer, WS, { since, known: [held] });
    const upserted = ids(delta.nodes.upsert);
    expect(upserted).toContain(granted);
    expect(upserted).not.toContain(hidden);
    expect(delta.nodes.delete).not.toContain(hidden); // never held, never readable: not named at all
  });

  it("a revoked task node goes to tasks.delete, not nodes.delete", async () => {
    const task = await note(`Task ${stamp}`, shared);
    await markAsTask(WS, task);
    await putInSpace(task, adminOnly);

    const delta = await buildSyncDelta(viewer, WS, { since, known: [task] });
    expect(delta.tasks.delete).toContain(task);
    expect(delta.nodes.delete).not.toContain(task);
  });

  it("an event about a note the reader can't hold names nothing", async () => {
    const hidden = await note(`Deleted elsewhere ${stamp}`, adminOnly);
    const from = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [hidden]);
    await event(WS, "NODE_DELETED", "node", hidden, {}, "user", admin.id);

    const forViewer = await buildSyncDelta(viewer, WS, { since: from, known: [] });
    expect(forViewer.nodes.delete).not.toContain(hidden);
    const forAdmin = await buildSyncDelta(admin, WS, { since: from, known: [] });
    expect(forAdmin.nodes.delete).toContain(hidden);
  });

  it("a late event about a deleted note (DISPATCHER_FAILED) does not cancel the delete", async () => {
    // Found by the two-device simulator: a cascade queued by an edit lost the race with the
    // delete, failed, and its audit event after NODE_DELETED kept the deleted note on both devices.
    const gone = await note(`Raced ${stamp}`, shared);
    const from = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.m);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [gone]);
    await event(WS, "NODE_DELETED", "node", gone, {}, "user", admin.id);
    await event(WS, "DISPATCHER_FAILED", "node", gone, { error: "node not found" }, "system", "dispatcher");
    const delta = await buildSyncDelta(admin, WS, { since: from, known: [] });
    expect(delta.nodes.delete).toContain(gone);
    expect(ids(delta.nodes.upsert)).not.toContain(gone);
  });

  it("without known (GET, the routine client) there is no membership diff", async () => {
    const leaving = await note(`Quiet ${stamp}`, shared);
    await putInSpace(leaving, adminOnly);
    const delta = await buildSyncDelta(viewer, WS, { since, known: [] });
    expect(delta.nodes.delete).not.toContain(leaving);
  });

  it("a held set over the cap answers resync_required instead of a partial diff", async () => {
    const known = Array.from({ length: MAX_KNOWN_IDS + 1 }, (_, i) => `id-${i}`);
    const delta = await buildSyncDelta(viewer, WS, { since: 0, known });
    expect(delta.resync_required).toBe(true);
    expect(delta.nodes).toEqual({ upsert: [], delete: [] });
  });

  it("says where the event log ends, so a cursor beyond it (a restored server) is recognisable", async () => {
    const head = (await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.m;
    const caughtUp = await buildSyncDelta(viewer, WS, { since: Number(head), known: [] });
    expect(caughtUp.head_event_id).toBe(head);
    const ahead = await buildSyncDelta(viewer, WS, { since: Number(head) + 5000, known: [] });
    expect(ahead.head_event_id).toBe(head);
    expect(BigInt(ahead.head_event_id)).toBeLessThan(BigInt(Number(head) + 5000));
    const resync = await buildSyncDelta(viewer, WS, { since: 0, known: Array.from({ length: MAX_KNOWN_IDS + 1 }, (_, i) => `id-${i}`) });
    expect(resync.head_event_id).toBe(head);
  });

  it("carries no block-node channel", async () => {
    const delta = await buildSyncDelta(viewer, WS, { since: 0, known: [] });
    expect(delta).not.toHaveProperty("blocks");
  });
});

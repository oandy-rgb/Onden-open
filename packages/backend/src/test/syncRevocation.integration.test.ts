import { persistActor } from "./helpers/persistActor.js";
// HIGH gap #2 — revocation propagation on /api/sync.
//
// When a node LEAVES an actor's read set via a PERMISSION change, NO
// node-targeted domain event is emitted (a move into another space changes
// space_id; a membership removal, token read-scope narrowing or space deletion
// live on the space / actor / token). The event-window delta therefore
// classifies the node into NEITHER upsert nor delete, and the client keeps a
// stale local copy forever.
//
// The fix: the client POSTs the node ids it currently HOLDS ({since, known}),
// and the backend diffs them against the CURRENT read set
// (readableNodeIdSet) — the SINGLE source of truth — emitting `nodes.delete`
// for any held id no longer readable. This is a CVR-style membership diff:
// vector-agnostic, fail-closed, mechanism-independent (any future readability
// rule propagates automatically).
//
// This suite proves the diff fires for ALL FOUR revocation mechanisms of the
// spaces model (docs/architecture/spaces.md: read = member of the note's
// space), and that the diff is TARGETED — it deletes only ids that genuinely
// left the current read set, never bystanders in the same space.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";

import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { markAsTask } from "./helpers/taskRef.js";
import syncRouter from "../routes/sync.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/sync", syncRouter);

const admin: ActorCtx = { id: "rev-admin", name: "Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "rev-viewer", name: "Viewer", role: "viewer", type: "human" };

const J = { "content-type": "application/json" };

type SyncResp = {
  nodes: { upsert: Array<{ id: string }>; delete: string[] };
  tasks: { upsert: Array<{ id: string }>; delete: string[] };
};

/** POST /api/sync carrying the client's held ids. */
async function syncWithKnown(since: number, known: string[]): Promise<SyncResp> {
  const res = await app.request("/api/sync", {
    method: "POST", headers: J, body: JSON.stringify({ since, known }),
  });
  expect(res.status, "POST /api/sync").toBe(200);
  return (await res.json()) as SyncResp;
}

describe.skipIf(!isTestDb)("sync revocation (CVR membership diff) (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let privateSpace = "";     // admin only — where revoked nodes are moved

  // Cursor captured before this suite seeds its fixtures. The shared onden_test
  // log accumulates events across the (serial) integration files, so since=0
  // would return only the newest 500 events — when prior files have logged >500,
  // this suite's fixture events fall off that page and the `before` upsert
  // assertions flake. Sync from baseCursor so the window always reaches them.
  // (Same fix modelInvariants uses.) Event ids may exceed 2^53 in a long-lived
  // test database, so step back a little before converting to a JS number.
  let baseCursor = 0;
  const cursorBelowHead = async () => Number(BigInt((await q<{ m: string }>(
    `SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m) - 256n);

  async function mkContent(title: string, slug: string, space?: string): Promise<string> {
    const r = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'body') RETURNING id`, [WS, title, slug]);
    const id = r.rows[0]!.id;
    if (space) await putInSpace(id, space);
    // A node enters the sync upsert set only via its events — emit one so the
    // FIRST sync (admin, readable) carries it (the "client now holds it" state).
    await event(WS, "NODE_UPDATED", "node", id, { title }, "user", "rev-someone");
    return id;
  }
  /** A shared space the viewer reads (admin manages it). */
  const viewerSpace = (name: string) => makeSpace(WS, name, [
    { id: admin.id, permission: "edit" }, { id: viewer.id, permission: "view" },
  ]);
  const applyTag = (nodeId: string, tagId: string) =>
    seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [nodeId, tagId]);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(viewer, await persistActor(WS, viewer));
    privateSpace = await makeSpace(WS, `rev-private-${stamp}`, [{ id: admin.id, permission: "edit" }]);
    baseCursor = await cursorBelowHead();
  });

  it("(1) moved into a space the reader is not in → the held node is emitted in nodes.delete", async () => {
    currentActor = viewer;
    const nodeId = await mkContent(`rev move ${stamp}`, `rev-move-node-${stamp}`, await viewerSpace(`rev-move-${stamp}`));
    const known = [nodeId];
    // Before: readable — present as upsert, absent from delete.
    const before = await syncWithKnown(baseCursor, known);
    expect(before.nodes.upsert.some((n) => n.id === nodeId)).toBe(true);
    expect(before.nodes.delete).not.toContain(nodeId);

    // Move it into the admin-only space. No node-targeted event is emitted.
    await putInSpace(nodeId, privateSpace);

    // After: the membership diff (against the current read set) emits the delete,
    // even though the node never appears in any event since the watermark.
    const after = await syncWithKnown(baseCursor, known);
    expect(after.nodes.delete).toContain(nodeId);
    expect(after.nodes.upsert.some((n) => n.id === nodeId)).toBe(false);
  });

  it("(2) removed from the space → the held node is emitted in nodes.delete", async () => {
    currentActor = viewer;
    const space = await viewerSpace(`rev-member-${stamp}`);
    const nodeId = await mkContent(`rev member ${stamp}`, `rev-member-node-${stamp}`, space);
    const known = [nodeId];
    const before = await syncWithKnown(baseCursor, known);
    expect(before.nodes.upsert.some((n) => n.id === nodeId)).toBe(true);
    expect(before.nodes.delete).not.toContain(nodeId);

    await q(`DELETE FROM space_members WHERE space_id=$1 AND actor_id=$2`, [space, viewer.id]);
    const after = await syncWithKnown(baseCursor, known);
    expect(after.nodes.delete).toContain(nodeId);
  });

  it("(3) bearer-token agent removed from the space → the held node is emitted in nodes.delete", async () => {
    const tokenActor = await persistActor(WS, {
      id: "rev-token-actor", name: "Token", role: "editor", type: "agent",
      tokenScope: { tokenId: `rev-tok-${stamp}`, allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
    });
    // A token reaches its agent's memberships (no per-token space list).
    const space = await makeSpace(WS, `rev-token-${stamp}`, [{ id: tokenActor.id, permission: "edit" }]);
    const nodeId = await mkContent(`rev token ${stamp}`, `rev-token-node-${stamp}`, space);
    const known = [nodeId];
    const scopedToken = { ...tokenActor };
    currentActor = scopedToken;
    const before = await syncWithKnown(baseCursor, known);
    expect(before.nodes.upsert.some((n) => n.id === nodeId)).toBe(true);

    // Remove the agent from the space: the token's reach narrows with it.
    await q("DELETE FROM space_members WHERE space_id=$1 AND actor_id=$2", [space, tokenActor.id]);
    // Keep the injected identity stale: the read snapshot must reload the grant.
    currentActor = scopedToken;
    const after = await syncWithKnown(baseCursor, known);
    expect(after.nodes.delete).toContain(nodeId);
  });

  it("(4) the space is deleted → the held node is emitted in nodes.delete", async () => {
    currentActor = viewer;
    const space = await viewerSpace(`rev-gone-${stamp}`);
    const nodeId = await mkContent(`rev gone ${stamp}`, `rev-gone-node-${stamp}`, space);
    const known = [nodeId];
    const before = await syncWithKnown(baseCursor, known);
    expect(before.nodes.upsert.some((n) => n.id === nodeId)).toBe(true);
    expect(before.nodes.delete).not.toContain(nodeId);

    await q(`UPDATE spaces SET deleted_at = now() WHERE id = $1`, [space]);
    const after = await syncWithKnown(baseCursor, known);
    expect(after.nodes.delete).toContain(nodeId);
  });

  it("targeted: moving ONE held node out revokes it, but a bystander in the same space is NOT deleted", async () => {
    currentActor = viewer;
    const space = await viewerSpace(`rev-multi-${stamp}`);
    const movedId = await mkContent(`rev multi ${stamp}`, `rev-multi-node-${stamp}`, space);
    const bystanderId = await mkContent(`rev bystander ${stamp}`, `rev-bystander-node-${stamp}`, space);
    // The client holds BOTH.
    const known = [movedId, bystanderId];
    const before = await syncWithKnown(baseCursor, known);
    expect(before.nodes.upsert.some((n) => n.id === movedId)).toBe(true);
    expect(before.nodes.upsert.some((n) => n.id === bystanderId)).toBe(true);
    expect(before.nodes.delete).not.toContain(movedId);
    expect(before.nodes.delete).not.toContain(bystanderId);

    await putInSpace(movedId, privateSpace);

    const after = await syncWithKnown(baseCursor, known);
    expect(after.nodes.delete).toContain(movedId);
    expect(after.nodes.delete).not.toContain(bystanderId);
  });

  it("backstop: revocation is emitted even when the event window carried nothing (since at the head)", async () => {
    // A fresh node, revoked, with `since` at the current head so the event
    // window is EMPTY — the diff must still run (no early-return before it).
    currentActor = viewer;
    const nodeId = await mkContent(`rev backstop ${stamp}`, `rev-backstop-node-${stamp}`, await viewerSpace(`rev-backstop-${stamp}`));
    const head = (await q<{ max: string }>(`SELECT COALESCE(MAX(id),0)::text AS max FROM domain_events`)).rows[0]!.max;
    await putInSpace(nodeId, privateSpace);

    const after = await syncWithKnown(Number(head), [nodeId]);
    expect(after.nodes.delete).toContain(nodeId);
  });

  it("GRANT: a node that BECOMES readable (no node event) is emitted as an upsert (positive diff)", async () => {
    // The symmetric twin of revocation. A permission WIDENING (joining a
    // space, a node moved in, scope expanded) emits NO node-targeted event, so
    // the newly-readable node the client doesn't hold would never arrive via
    // the event delta. The positive membership diff (readable − known) must
    // surface it.
    currentActor = viewer;
    // Start restricted: a space the viewer is not in.
    const space = await makeSpace(WS, `grant-${stamp}`, [{ id: admin.id, permission: "edit" }]);
    const grantNodeId = await mkContent(`grant ${stamp}`, `grant-node-${stamp}`, space);
    // A held, always-readable node so the client is in CVR mode (known non-empty)
    // but does NOT list the restricted node.
    const heldId = await mkContent(`grant held ${stamp}`, `grant-held-${stamp}`);

    // Before: restricted → NOT readable, so NOT upserted (and the window event
    // for it is read-filtered out).
    const before = await syncWithKnown(baseCursor, [heldId]);
    expect(before.nodes.upsert.some((n) => n.id === grantNodeId)).toBe(false);

    // The viewer joins the space. No node-targeted event is emitted.
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'view')`, [space, viewer.id]);

    // After: the positive diff (readable − known) surfaces it as an upsert, even
    // though `since` is past its only event (caught up). known omits it → granted.
    const head = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
    const after = await syncWithKnown(head, [heldId]);
    expect(after.nodes.upsert.some((n) => n.id === grantNodeId)).toBe(true);
    expect(after.nodes.delete).not.toContain(grantNodeId);
  });

  it("TASK revocation: a revoked TASK node lands in tasks.delete (NOT nodes.delete)", async () => {
    // A task node = a content node carrying the 'task' class_tag. When its read
    // access is revoked it must be deleted via the TASKS channel — the client
    // deletes tasks by their own id there; routing it to nodes.delete (host-only
    // cascade) left the revoked task lingering locally.
    currentActor = viewer;
    const taskNodeId = await mkContent(`rev task ${stamp}`, `rev-task-node-${stamp}`, await viewerSpace(`rev-task-${stamp}`));
    await markAsTask(WS, taskNodeId); // makes it a TASK node

    // Before: readable → not in any delete channel.
    const before = await syncWithKnown(baseCursor, [taskNodeId]);
    expect(before.tasks.delete).not.toContain(taskNodeId);
    expect(before.nodes.delete).not.toContain(taskNodeId);

    // Move the task node into the admin-only space → it leaves the read set.
    await putInSpace(taskNodeId, privateSpace);

    // The revocation routes by the node's 'task' tag (taskNodeIdsAmong), so it
    // lands in the TASKS delete channel — where the client deletes by the task's
    // OWN id — NOT in nodes.delete (a host-only cascade that would miss it).
    const after = await syncWithKnown(baseCursor, [taskNodeId]);
    expect(after.tasks.delete).toContain(taskNodeId);     // revoked via the TASKS channel
    expect(after.nodes.delete).not.toContain(taskNodeId); // NOT the nodes channel
  });
});

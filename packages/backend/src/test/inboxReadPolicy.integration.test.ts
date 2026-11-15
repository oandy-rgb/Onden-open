// Review 2026-06-11 (security) — the governance inbox is ALSO a read surface.
// GET /api/inbox returned EVERY unreviewed ai_agent event with its full
// payload, so a viewer-role caller (or a tag-scoped bearer token) read
// restricted node titles straight out of NODE_CREATED/NODE_UPDATED payloads,
// bypassing the read policy that /api/events already enforces via
// readableNodeIdSet. Approve/reject had the same hole: a reviewer could act on
// (and via reject, REVERT) an event about a node they cannot read. Reviewing is
// now the workspace owner's alone, so the same hole is pinned two ways: a
// non-owner member is refused (403), and the owner is refused (404, no
// existence oracle) for an event about a node in a space they are not in.
//
// Seed: a node in an admin-only space + a public node, each with an
// unreviewed ai_agent event carrying its title. Pin:
//   • the viewer's inbox shows only the public event; the admin's shows both;
//   • a bearer token that reaches no space sees nothing;
//   • approve/reject 403s for a non-owner member (even on a node they can read),
//     and 404s for the owner on a node in a space the owner is not in, while
//     the owner can still approve what they can read.
//
// Mirrors src/test/roleReadPolicy.integration.test.ts.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import inboxRouter from "../routes/inbox.js";
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
app.route("/api/inbox", inboxRouter);

let viewer: ActorCtx = { id: "irp-viewer", name: "Viewer", role: "viewer", type: "human" };
let member: ActorCtx = { id: "irp-member", name: "Member", role: "editor", type: "human" };
let admin: ActorCtx = { id: "irp-admin", name: "Admin", role: "admin", type: "human" };
// A delegated bearer token whose agent is in no space (membership is deleted
// in beforeAll): readable set = ∅.
let scopedToken: ActorCtx = {
  id: "irp-token", name: "Scoped token", role: "editor", type: "agent",
  tokenScope: { tokenId: "irp-tok-1", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
};

describe.skipIf(!isTestDb)("inbox read-policy (DB)", () => {
  let WS = "";
  let secretId = "";
  let publicId = "";
  let secretEventId = "";       // listed (or not) by GET /
  let hiddenFromOwnerId = "";    // in a space nobody (the owner included) is in
  let secretApproveEventId = ""; // the non-owner's refused approve
  let secretRejectEventId = "";  // the non-owner's refused reject
  let ownerHiddenApproveEventId = ""; // about a note the owner cannot read
  let ownerHiddenRejectEventId = "";
  let publicEventId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    viewer = await persistActor(WS, viewer);
    member = await persistActor(WS, member);
    admin = await persistActor(WS, admin);
    scopedToken = await persistActor(WS, scopedToken);
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [scopedToken.id]);
    const stamp = Date.now();

    const secret = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Restricted salary data ${stamp}','irp-secret-node-${stamp}','TOP SECRET BODY') RETURNING id`,
      [WS]);
    secretId = secret.rows[0]!.id;
    // Restricted: in a space only the admin belongs to.
    await putInSpace(secretId, await adminOnlySpace(WS, `irp-secret-${stamp}`, [admin.id]));

    const hidden = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Hidden from owner ${stamp}','irp-hidden-node-${stamp}','NOBODY READS THIS') RETURNING id`,
      [WS]);
    hiddenFromOwnerId = hidden.rows[0]!.id;
    await putInSpace(hiddenFromOwnerId, await adminOnlySpace(WS, `irp-hidden-${stamp}`, []));

    const pub = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Public note ${stamp}','irp-public-${stamp}','hello') RETURNING id`,
      [WS]);
    publicId = pub.rows[0]!.id;

    // Unreviewed agent events — the restricted ones' payloads carry the title,
    // the exact leak the inbox must now stop.
    secretEventId = await event(WS, "NODE_UPDATED", "node", secretId,
      { title: `Restricted salary data ${stamp}` }, "ai_agent", "irp-agent");
    secretApproveEventId = await event(WS, "NODE_UPDATED", "node", secretId,
      { title: `Restricted salary data ${stamp} (2)` }, "ai_agent", "irp-agent");
    secretRejectEventId = await event(WS, "NODE_UPDATED", "node", secretId,
      { title: `Restricted salary data ${stamp} (3)` }, "ai_agent", "irp-agent");
    ownerHiddenApproveEventId = await event(WS, "NODE_UPDATED", "node", hiddenFromOwnerId,
      { title: `Hidden from owner ${stamp}` }, "ai_agent", "irp-agent");
    ownerHiddenRejectEventId = await event(WS, "NODE_UPDATED", "node", hiddenFromOwnerId,
      { title: `Hidden from owner ${stamp} (2)` }, "ai_agent", "irp-agent");
    publicEventId = await event(WS, "NODE_UPDATED", "node", publicId,
      { title: `Public note ${stamp}` }, "ai_agent", "irp-agent");
  });

  const list = async () =>
    (await (await app.request("/api/inbox?limit=500")).json()).events as Array<{ id: string }>;
  const has = (events: Array<{ id: string }>, id: string) => events.some((e) => e.id === id);

  it("queue: a viewer sees only public-node agent events; an admin sees restricted ones too", async () => {
    currentActor = viewer;
    const v = await list();
    expect(has(v, publicEventId)).toBe(true);
    expect(has(v, secretEventId)).toBe(false);
    expect(has(v, secretApproveEventId)).toBe(false);

    currentActor = admin;
    const a = await list();
    expect(has(a, publicEventId)).toBe(true);
    expect(has(a, secretEventId)).toBe(true);
  });

  it("queue: a bearer token whose agent is in no space sees no node events", async () => {
    currentActor = scopedToken;
    const t = await list();
    expect(has(t, publicEventId)).toBe(false);
    expect(has(t, secretEventId)).toBe(false);
  });

  it("queue: events the viewer can't see don't use up the 500-event window", async () => {
    // 520 newer restricted events. Filtering after the LIMIT used to fill the
    // window with them and drop the older public event from the viewer's queue.
    const flood = await q<{ id: string }>(
      `INSERT INTO domain_events (id, workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
       SELECT nextval(pg_get_serial_sequence('domain_events', 'id')), $1, 'ai_agent', 'irp-agent',
              'NODE_UPDATED', 'node', $2, jsonb_build_object('title', 'flood ' || g)
         FROM generate_series(1, 520) g
       RETURNING id::text`,
      [WS, secretId]);
    try {
      currentActor = viewer;
      const v = await list();
      expect(has(v, publicEventId)).toBe(true);
      expect(v.some((e) => flood.rows.some((f) => f.id === e.id))).toBe(false);
    } finally {
      // Take the flood out of the queue for the tests below.
      await q(
        `INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by)
         SELECT unnest($2::bigint[]), $1, 'approved', 'irp-cleanup'`,
        [WS, flood.rows.map((f) => f.id)]);
    }
  });

  it("approve: a non-owner member is refused (403) on an event about a node they cannot read", async () => {
    currentActor = member;
    const res = await app.request(`/api/inbox/${secretApproveEventId}/approve`, { method: "POST" });
    expect(res.status).toBe(403);
    // No review row landed — the event is still unreviewed.
    const reviewed = await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [secretApproveEventId]);
    expect(reviewed.rows.length).toBe(0);
  });

  it("reject: a non-owner member is refused (403) on an event about a node they cannot read", async () => {
    currentActor = member;
    const res = await app.request(`/api/inbox/${secretRejectEventId}/reject`, { method: "POST" });
    expect(res.status).toBe(403);
    const reviewed = await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [secretRejectEventId]);
    expect(reviewed.rows.length).toBe(0);
  });

  it("approve: 404 for the owner on an event about a node in a space the owner is not in", async () => {
    currentActor = admin;
    const res = await app.request(`/api/inbox/${ownerHiddenApproveEventId}/approve`, { method: "POST" });
    expect(res.status).toBe(404); // not 403: the id must not be an existence oracle
    const reviewed = await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [ownerHiddenApproveEventId]);
    expect(reviewed.rows.length).toBe(0);
  });

  it("reject: 404 for the owner on an event about a node in a space the owner is not in", async () => {
    currentActor = admin;
    const res = await app.request(`/api/inbox/${ownerHiddenRejectEventId}/reject`, { method: "POST" });
    expect(res.status).toBe(404);
    const reviewed = await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [ownerHiddenRejectEventId]);
    expect(reviewed.rows.length).toBe(0);
  });

  it("approve: the admin (who can read the node) still approves it", async () => {
    // Its own event: approving consumes it, and the member's refusal above
    // checks that secretApproveEventId stays unreviewed.
    const own = await event(WS, "NODE_UPDATED", "node", secretId, { title: "Restricted salary data (admin)" }, "ai_agent", "irp-agent");
    currentActor = admin;
    const res = await app.request(`/api/inbox/${own}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("approved");
  });

  it("approve: a non-owner member cannot review even an event on a node they CAN read", async () => {
    // Its own event: the queue tests expect publicEventId still unreviewed.
    const own = await event(WS, "NODE_UPDATED", "node", publicId, { title: "Public note (member)" }, "ai_agent", "irp-agent");
    currentActor = member;
    const res = await app.request(`/api/inbox/${own}/approve`, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [own])).rows.length).toBe(0);
  });

  it("approve: the owner can review events on nodes they CAN read", async () => {
    const own = await event(WS, "NODE_UPDATED", "node", publicId, { title: "Public note (owner)" }, "ai_agent", "irp-agent");
    currentActor = admin;
    const res = await app.request(`/api/inbox/${own}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

// Inbox approve through the spine (Phase C cont.) against a real Postgres.
// Approving an agent change is a governance decision: it must be authority-gated
// (the workspace owner), leave an attributed EVENT_APPROVED audit event atomic with
// the event_reviews row, and be a clean no-op (no second event) once reviewed.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, event, getWorkspaceId } from "../db.js";
import inboxRouter from "../routes/inbox.js";
import type { ActorCtx } from "../types.js";
import { persistActor, nativeOwnerActor } from "./helpers/persistActor.js";
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

// The workspace owner (fixture shorthand "admin" human); the only person who reviews.
let owner: ActorCtx = { id: "own-1", name: "Own", role: "admin", type: "human" };
// A member who used to hold the reviewer role: now a plain editing member.
let reviewer: ActorCtx = { id: "rev-1", name: "Rev", role: "reviewer", type: "human" };
let editor: ActorCtx = { id: "ed-1", name: "Ed", role: "editor", type: "human" };
// A delegated bearer token, even with the admin role — must NOT be able to review.
let agentToken: ActorCtx = {
  id: "ag-1", name: "Bot", role: "admin", type: "agent",
  tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
};
// The native-app owner: a type='agent' System actor with NO tokenScope. Must be
// treated as the principal (can review) — gating on type would lock the owner out.
// (nativeOwnerActor: the real System actor, external_id 'system'.)
let nativeOwner: ActorCtx | null = null;

const approve = (eventId: string) => app.request(`/api/inbox/${eventId}/approve`, { method: "POST" });
const approvedEventsFor = (reviewedId: string) =>
  q<{ actor_type: string; actor_id: string }>(
    `SELECT actor_type, actor_id FROM domain_events
      WHERE event_type = 'EVENT_APPROVED' AND target_id = $1`,
    [reviewedId],
  );

describe.skipIf(!isTestDb)("inbox approve via spine (DB)", () => {
  let WS = "";
  let node = "";
  // Mint a fresh agent-authored event to approve in each test.
  const agentEvent = async () => {
    return event(WS, "NODE_UPDATED", "node", node, {}, "ai_agent", agentToken.id);
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default')
             ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    reviewer = await persistActor(WS, reviewer);
    owner = await persistActor(WS, owner);
    editor = await persistActor(WS, editor);
    agentToken = await persistActor(WS, agentToken);
    nativeOwner = await nativeOwnerActor(WS);
    node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Doc','doc-${Date.now()}','b') RETURNING id`,
      [WS],
    )).rows[0]!.id;
  });

  it("the owner approves: EVENT_APPROVED attributed + event_reviews row, then 409 no-op", async () => {
    const evId = await agentEvent();
    currentActor = owner;
    const res = await approve(evId);
    expect(res.status).toBe(200);

    const ap = await approvedEventsFor(evId);
    expect(ap.rows.length).toBe(1);
    expect(ap.rows[0]!.actor_type).toBe("user"); // human owner → 'user'
    expect(ap.rows[0]!.actor_id).toBe(owner.id);
    const review = await q(`SELECT decision FROM event_reviews WHERE event_id = $1::bigint`, [evId]);
    expect(review.rows[0]).toMatchObject({ decision: "approved" });

    // Approve again → 409, and NO second EVENT_APPROVED event (rolled back).
    const again = await approve(evId);
    expect(again.status).toBe(409);
    expect((await approvedEventsFor(evId)).rows.length).toBe(1);
  });

  it("a non-owner member (editor, former reviewer) is refused, with no review row and no event", async () => {
    const evId = await agentEvent();
    for (const member of [editor, reviewer]) {
      currentActor = member;
      expect((await approve(evId)).status).toBe(403);
    }
    expect((await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [evId])).rows.length).toBe(0);
    expect((await approvedEventsFor(evId)).rows.length).toBe(0);
  });

  it("a delegated token (even admin role) cannot approve — review is the principal's", async () => {
    const evId = await agentEvent();
    currentActor = agentToken; // has tokenScope → blocked regardless of role
    expect((await approve(evId)).status).toBe(403);
    expect((await approvedEventsFor(evId)).rows.length).toBe(0);
  });

  it("the native-app owner (type='agent' System actor, NO tokenScope) CAN approve — owner not locked out", async () => {
    const evId = await agentEvent();
    currentActor = nativeOwner; // the owner on the native app (reviewAuthority)
    expect((await approve(evId)).status).toBe(200);
    expect((await approvedEventsFor(evId)).rows.length).toBe(1);
  });
});

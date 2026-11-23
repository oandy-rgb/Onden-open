// Background work that writes an event in the name of an actor captured BEFORE it ran — when the work was queued — and the actor is
// removed in between (PR #1875, the security review's condition 1). The database refuses a new event whose uuid actor_id resolves to no
// actor (migration 071), so before this file each of these jobs failed in its own way:
//   - dispatcher catch-up: the documented "actor gone → discard with a DISPATCHER_FAILED audit" could never be written; the discard
//     rolled back, the intent stayed, and every catch-up replayed it again;
//   - a live dispatcher failure: its DISPATCHER_FAILED audit threw from the catch, and the returned promise rejected;
//   - an approved tag pack (outbox `tag_pack`): TAG_IMPORTED under the removed proposer threw, the install rolled back, and the row was
//     retried for a day and then buried as dead — an approved import lost because its proposer was removed.
// The rule (spine/currentActor.ts signatureForCapturedActor): the job still completes, and its record is signed as the system with
// REMOVED_ACTOR_REF; the removed actor's id stays in the payload (`removed_actor_id`) so the record can be tied to their earlier events.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, event, getWorkspaceId } from "../db.js";
import { enqueueCascadeIntent, queueDispatcher, runDispatcherCatchup } from "../services/dispatcherQueue.js";
import { enqueueTagPackProposal } from "../services/tagPacks.js";
import { approveHeldEffect, drainOutbox } from "../services/outbox.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { UnauthorizedError } from "../spine/actor.js";
import { buildAndEnqueueSnapshot } from "../modules/website/publishing/snapshot.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const stamp = Date.now();
let seq = 0;

/** A member created and removed the way the owner does it (POST / DELETE /api/actors through the native sign-in). */
async function createMember(type: "agent"): Promise<string> {
  const res = await app.request("/api/actors", {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ name: `car ${type} ${stamp}-${++seq}`, type }),
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}
async function removeMember(id: string): Promise<void> {
  const res = await app.request(`/api/actors/${id}`, { method: "DELETE", headers: { origin: "http://localhost" } });
  expect(res.status).toBeLessThan(300);
  expect((await q(`SELECT 1 FROM actors WHERE id = $1`, [id])).rowCount, "the member is gone").toBe(0);
}

describe.skipIf(!isTestDb)("work queued by an actor who is removed before it runs", () => {
  let WS = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  async function mkNode(label: string): Promise<string> {
    const r = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden)
       VALUES ($1, 'manual', 'content', $2, $3, 'status:: done', false) RETURNING id`,
      [WS, `car ${label} ${stamp}`, `car-${label}-${stamp}-${++seq}`],
    );
    return r.rows[0]!.id;
  }
  const failures = (nodeId: string) => q<{ actor_type: string; actor_id: string; payload: { error?: string; removed_actor_id?: string } }>(
    `SELECT actor_type, actor_id, payload FROM domain_events WHERE target_id = $1 AND event_type = 'DISPATCHER_FAILED'`, [nodeId],
  );

  it("dispatcher catch-up: an intent whose actor was removed is discarded and audited, not replayed at every catch-up", async () => {
    const actorId = await createMember("agent");
    await joinDefaultSpace(WS, actorId, "editor");
    const nodeId = await mkNode("catchup");
    // The committed trigger and its durable intent, with no cascade after it: what a crash leaves behind.
    const eventId = await event(WS, "NODE_UPDATED", "node", nodeId, { title: "car trigger" }, "user", actorId,
      { txMeta: { ui_context: "test.simulated_crash" } });
    await enqueueCascadeIntent({ workspaceId: WS, nodeId, actor: { id: actorId, name: "x", type: "agent" }, label: "node.patch.cascade", eventId });
    await removeMember(actorId);

    await runDispatcherCatchup();

    expect((await q(`SELECT 1 FROM dispatcher_pending WHERE event_id = $1::bigint`, [eventId])).rowCount, "the intent is consumed").toBe(0);
    const fail = (await failures(nodeId)).rows;
    expect(fail).toHaveLength(1);
    expect(fail[0]!.payload.error).toMatch(/actor missing/);
    expect(fail[0]).toMatchObject({ actor_type: "system", actor_id: "removed-actor" });
    expect(fail[0]!.payload.removed_actor_id).toBe(actorId);
  });

  it("a live dispatcher failure after its actor was removed is audited and does not reject", async () => {
    const actorId = await createMember("agent");
    const nodeId = await mkNode("live");
    await removeMember(actorId);

    await expect(queueDispatcher(
      { workspaceId: WS, nodeId, actorId, label: "test.live", retryTransient: false },
      async () => { throw new Error("cascade broke"); },
    )).resolves.toBeUndefined();

    const fail = (await failures(nodeId)).rows;
    expect(fail).toHaveLength(1);
    expect(fail[0]).toMatchObject({ actor_type: "system", actor_id: "removed-actor" });
    expect(fail[0]!.payload).toMatchObject({ error: "cascade broke", removed_actor_id: actorId });
  });

  it("a tag pack approved before its proposing agent was removed still installs, signed as the system", async () => {
    const agentId = await createMember("agent");
    const name = `carpack${stamp}-${++seq}`;
    const pack = { name, description: "cards", fields: [{ name: "due", type: "date" }] };
    await withEventTransaction(WS, () => enqueueTagPackProposal({ workspaceId: WS, pack, requestedByActorId: agentId, requestedByActorType: "ai_agent" }));
    const held = (await q<{ id: string }>(
      `SELECT id::text FROM outbox WHERE workspace_id = $1 AND effect_kind = 'tag_pack' AND dedup_key = $2 AND status = 'pending_approval'`,
      [WS, `tag_pack:${WS}:${name}`],
    )).rows[0]!;
    // The owner approves (only the status flip; the route's immediate drain is what this test runs by hand below) …
    const approved = await withEventTransaction(WS, () => approveHeldEffect(WS, held.id));
    expect(approved?.performId).toBe(held.id);
    // … and removes the agent before the drain reaches the row.
    await removeMember(agentId);

    await drainOutbox({ workspaceId: WS, id: held.id });

    const row = (await q<{ status: string; last_error: string | null }>(`SELECT status, last_error FROM outbox WHERE id = $1::bigint`, [held.id])).rows[0]!;
    expect(row, "the approved import is not lost").toMatchObject({ status: "done" });
    const tag = (await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND node_type = 'class_tag' AND deleted_at IS NULL`, [WS, name],
    )).rows[0];
    expect(tag, "the pack's tag exists").toBeTruthy();
    const imported = (await q<{ actor_type: string; actor_id: string; payload: { via_approval?: boolean; removed_actor_id?: string } }>(
      `SELECT actor_type, actor_id, payload FROM domain_events WHERE target_id = $1 AND event_type = 'TAG_IMPORTED'`, [tag!.id],
    )).rows;
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ actor_type: "system", actor_id: "removed-actor" });
    expect(imported[0]!.payload).toMatchObject({ via_approval: true, removed_actor_id: agentId });
  });

  // Not background work: POST /api/publish checks the site admin at sign-in, then builds the snapshot and writes PUBLISH_SNAPSHOT_CREATED
  // under the event lock with that request's actor — the shape of the tool-call audit this PR fixed. Called here the way the route calls it
  // after its check passed, with an actor removed in between (the two-connection race of removedActorCredentialConcurrent, made sequential).
  it("a publish whose actor was removed after its permission check is refused like a credential that never existed, and stores nothing", async () => {
    const actorId = await createMember("agent");
    await removeMember(actorId);
    const before = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rows[0]!.n;

    await expect(buildAndEnqueueSnapshot(WS, { id: actorId, type: "agent" }, { title: "car site" })).rejects.toBeInstanceOf(UnauthorizedError);

    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rows[0]!.n).toBe(before);
    expect((await q(`SELECT 1 FROM domain_events WHERE actor_id = $1 AND event_type = 'PUBLISH_SNAPSHOT_CREATED'`, [actorId])).rowCount).toBe(0);
  });
});

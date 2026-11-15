// P4.4 Gap B — inbox reject paths agree on irreversible/no-op restore codes.
//
// Before this fix the SINGLE reject path threw on ANY restore error code, so an
// agent event whose target was already in the reverted state (restore returns
// `already_in_state`) was left stuck in the queue with no review row — while the
// GROUP and BATCH paths recorded it as rejected (restore_event_id NULL) and
// cleared it. That divergence made the event_reviews audit trail depend on which
// button the reviewer clicked. All three paths must now behave identically:
//   - unsupported / already_in_state → record decision='rejected', NULL restore,
//     leave the queue;
//   - genuinely irreversible (external / target_gone / patch_conflict) → record
//     nothing, stay in the queue.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import inboxRouter from "../routes/inbox.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

// A workspace of its own: "stays in / leaves the queue" reads the inbox's
// first page, which in the shared default workspace holds other tests'
// events; and the file no longer wipes that workspace to make room.
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api/inbox", inboxRouter);

const createNode = (title: string) =>
  app.request("/api/nodes", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, markdown: "body" }),
  });
const createdEventId = async (nodeId: string): Promise<string> =>
  (await q<{ id: string }>(
    `SELECT id::text FROM domain_events WHERE event_type = 'NODE_CREATED' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`,
    [nodeId],
  )).rows[0]!.id;
const reviewRow = (eventId: string) =>
  q<{ decision: string; restore_event_id: string | null }>(
    `SELECT decision, restore_event_id::text FROM event_reviews WHERE event_id = $1::bigint`, [eventId]);
const inQueue = async (eventId: string): Promise<boolean> => {
  const inbox = await (await app.request("/api/inbox")).json();
  return inbox.events.some((e: { id: string }) => e.id === eventId);
};

describe.skipIf(!isTestDb)("inbox reject consistency on no-op restore codes (P4.4 Gap B)", () => {
  const ids = { human: "", agent: "" };

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Reject consistency', $1) RETURNING id`, [`p44-${randomUUID()}`]);
    workspaceId = ws.rows[0]!.id;
    const mk = async (name: string, type: string, role: string) =>
      (await q<{ id: string }>(
        `INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,$3) RETURNING id`,
        [workspaceId, name, type])).rows[0]!.id;
    ids.human = await mk("Human", "human", "admin");
    ids.agent = await mk("Agent", "agent", "editor");
    // membership is explicit since 097: both work in 共用
    await joinDefaultSpace(workspaceId, ids.human, "admin");
    await joinDefaultSpace(workspaceId, ids.agent, "editor");
  });

  const asHuman = () => { currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" }; };
  const asAgent = () => { currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" }; };

  // Agent creates a node, then we pre-revert it (soft delete) WITHOUT recording a
  // review — so the NODE_CREATED's inverse (soft delete) is a no-op:
  // restoreEvent returns already_in_state.
  async function agentCreatedThenPreReverted(title: string): Promise<string> {
    asAgent();
    const node = await (await createNode(title)).json();
    const eid = await createdEventId(node.id);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [node.id]);
    return eid;
  }

  it("SINGLE reject records rejected+NULL restore and clears the queue (was: stuck)", async () => {
    const eid = await agentCreatedThenPreReverted("single-noop");
    asHuman();
    const res = await app.request(`/api/inbox/${eid}/reject`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("rejected");
    expect(body.restore).toBeNull(); // no restore ran

    const rev = await reviewRow(eid);
    expect(rev.rows[0]?.decision).toBe("rejected");
    expect(rev.rows[0]?.restore_event_id).toBeNull();
    expect(await inQueue(eid)).toBe(false);
  });

  it("BATCH reject records the identical row shape for the same no-op code", async () => {
    const eid = await agentCreatedThenPreReverted("batch-noop");
    asHuman();
    const res = await app.request(`/api/inbox/batch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", event_ids: [eid] }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decided).toBe(1);
    expect(body.decided_ids).toContain(eid);

    const rev = await reviewRow(eid);
    expect(rev.rows[0]?.decision).toBe("rejected");
    expect(rev.rows[0]?.restore_event_id).toBeNull(); // identical to single path
    expect(await inQueue(eid)).toBe(false);
  });

  it("a NORMAL single reject still records the restore_event_id (regression guard)", async () => {
    asAgent();
    const node = await (await createNode("single-real")).json();
    const eid = await createdEventId(node.id);
    asHuman();
    const res = await app.request(`/api/inbox/${eid}/reject`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const rev = await reviewRow(eid);
    expect(rev.rows[0]?.decision).toBe("rejected");
    expect(rev.rows[0]?.restore_event_id).toBeTruthy(); // a real inverse ran
  });
});

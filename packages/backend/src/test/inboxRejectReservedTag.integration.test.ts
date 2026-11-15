// T1 follow-up: rejecting an agent event whose inverse would trash a reserved
// tag is a restore refusal (code reserved_tag), not an exception. One such item
// in an inbox batch is skipped; the rest of the batch still applies.
//
// The case: before T1, an agent undeleted a #task trashed earlier. Rejecting
// that NODE_UNDELETED would trash #task again, which reservedTags refuses.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { event, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import inboxRouter from "../routes/inbox.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

// A workspace of its own: it needs its own reserved #task (one per
// workspace) and becomes the workspace owner, neither of which it may do to
// the shared default workspace. The routes read the workspace through this.
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
const isLive = async (id: string): Promise<boolean> =>
  (await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`, [id])).rows.length === 1;

describe.skipIf(!isTestDb)("inbox reject skips a reserved-tag inverse (T1)", () => {
  const ids = { human: "", agent: "", task: "" };
  const human = (): ActorCtx => ({ id: ids.human, name: "Human", role: "admin", type: "human" });

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('T1 reserved', $1) RETURNING id`, [`t1-${randomUUID()}`])).rows[0]!.id;
    const mk = async (name: string, type: string, role: string) =>
      (await q<{ id: string }>(
        `INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,$3) RETURNING id`,
        [workspaceId, name, type])).rows[0]!.id;
    ids.human = await mk("Human", "human", "admin");
    ids.agent = await mk("Agent", "agent", "editor");
    await joinDefaultSpace(workspaceId, ids.human, "admin");
    await joinDefaultSpace(workspaceId, ids.agent, "editor");
    // The owner may change tag definitions, so only the reserved-tag rule refuses.
    await setWorkspaceOwner(workspaceId, ids.human);
    ids.task = (await seedQ<{ id: string }>(
      // The tasks module's tag (migration 135) keeps the reserved tags' protection.
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_schema)
       VALUES ($1, 'manual', 'class_tag', 'task', $2, '{"module":"tasks"}'::jsonb) RETURNING id`,
      [workspaceId, `t1-task-${Date.now()}`],
    )).rows[0]!.id;
  });

  /** The agent's pre-T1 undelete of #task, as history records it. */
  const agentUndeletedTask = () =>
    event(workspaceId, "NODE_UNDELETED", "node", ids.task, { title: "task" }, "ai_agent", ids.agent,
      { txMeta: { inverse_op: "node.deleted", ui_context: "node.undelete" } });

  async function agentCreated(title: string): Promise<{ nodeId: string; eventId: string }> {
    currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    const node = (await (await createNode(title)).json()) as { id: string };
    return { nodeId: node.id, eventId: await createdEventId(node.id) };
  }

  it("restoreEvent answers reserved_tag (409) instead of throwing", async () => {
    const eid = await agentUndeletedTask();
    const r = await restoreEvent(eid, { cascade: false, actor: human(), workspaceId });
    expect(r).toMatchObject({ code: "reserved_tag", status: 409 });
    expect(await isLive(ids.task)).toBe(true);
  });

  it("a batch reject skips the reserved-tag item and still applies the others", async () => {
    const a = await agentCreated("t1-batch-a");
    const taskEvent = await agentUndeletedTask();
    const b = await agentCreated("t1-batch-b");

    currentActor = human();
    const res = await app.request("/api/inbox/batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", event_ids: [a.eventId, taskEvent, b.eventId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decided: number; decided_ids: string[]; skipped: Array<{ event_id: string; detail: string }> };
    expect(body.decided_ids.sort()).toEqual([a.eventId, b.eventId].sort());
    expect(body.skipped).toEqual([{ event_id: taskEvent, detail: expect.stringContaining("#task") }]);

    expect(await isLive(a.nodeId)).toBe(false);
    expect(await isLive(b.nodeId)).toBe(false);
    expect(await isLive(ids.task)).toBe(true);
    const review = await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [taskEvent]);
    expect(review.rows).toHaveLength(0); // the change stands, still in the queue
  });
});

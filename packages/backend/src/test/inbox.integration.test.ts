// Integration test for D7 inbox-as-governance (routes/inbox.ts) against a real
// Postgres. Exercises the governance promises unit tests can't reach:
//   - the queue is exactly the unreviewed, agent-authored events (not the
//     human's own changes, not other workspaces, not system noise)
//   - approve removes an event from the queue and is idempotent-guarded (409)
//   - reject runs the event's inverse-undo (the created node is soft-deleted)
//     AND removes it from the queue, and is double-reject-guarded (409)
//
// SAFETY: only runs against a *_test database; skips entirely otherwise.
//   DATABASE_URL=postgres://.../onden_test npx vitest run src/test/inbox.integration.test.ts

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import nodeRouter from "../routes/nodes.js";
import inboxRouter from "../routes/inbox.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api/inbox", inboxRouter);

const createNode = (title: string) =>
  app.request("/api/nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, markdown: "body" }),
  });
// The queue is workspace-wide and the shared default workspace holds other
// tests' agent events: read it filtered to this file's own actor.
let inboxActor = "";
const getInbox = (actorId = inboxActor) => app.request(`/api/inbox?actor_id=${actorId}`);
const approve = (id: string) => app.request(`/api/inbox/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const reject = (id: string) => app.request(`/api/inbox/${id}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

async function createdEventId(nodeId: string): Promise<string> {
  const r = await q<{ id: string }>(
    `SELECT id::text FROM domain_events
      WHERE event_type = 'NODE_CREATED' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`,
    [nodeId],
  );
  return r.rows[0]!.id;
}

describe.skipIf(!isTestDb)("inbox governance (DB)", () => {
  let workspaceId: string;
  const ids = { human: "", agent: "" };

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test', 'default')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
    const mk = async (name: string, type: string, role: string) => {
      const r = await q<{ id: string }>(
        `INSERT INTO actors (workspace_id, name, type) VALUES ($1, $2, $3) RETURNING id`,
        [workspaceId, name, type],
      );
      // The reviewer is the workspace owner (admin shorthand = owner).
      if (role === "admin") await setWorkspaceOwner(workspaceId, r.rows[0]!.id);
      await joinDefaultSpace(workspaceId, r.rows[0]!.id, role);
      return r.rows[0]!.id;
    };
    ids.human = await mk("Human", "human", "admin");
    ids.agent = await mk("Agent", "agent", "editor");
    inboxActor = ids.agent;
  });

  const asHuman = () => { currentActor = { id: ids.human, name: "Human", role: "admin", type: "human" }; };
  const asAgent = () => { currentActor = { id: ids.agent, name: "Agent", role: "editor", type: "agent" }; };

  it("queues agent-authored events but not the human's own", async () => {
    asAgent();
    const agentNode = await (await createNode("Agent note")).json();
    asHuman();
    await (await createNode("Human note")).json();

    const inbox = await (await getInbox()).json();
    const targets = inbox.events.map((e: { target_id: string }) => e.target_id);
    expect(targets).toContain(agentNode.id);
    // the human's create is self-authored — never in the governance queue
    const human = await (await getInbox(ids.human)).json();
    const humanEvents = human.events.filter((e: { actor_type: string }) => e.actor_type !== "ai_agent");
    expect(humanEvents.length).toBe(0);
  });

  it("approve removes the event from the queue and is guarded against repeats", async () => {
    asAgent();
    const node = await (await createNode("To approve")).json();
    const eid = await createdEventId(node.id);

    asHuman();
    const ok = await approve(eid);
    expect(ok.status).toBe(200);
    expect((await ok.json()).decision).toBe("approved");

    const inbox = await (await getInbox()).json();
    expect(inbox.events.find((e: { id: string }) => e.id === eid)).toBeUndefined();

    const again = await approve(eid);
    expect(again.status).toBe(409); // already reviewed
  });

  it("reject inverse-undoes the change (node soft-deleted) and leaves the queue", async () => {
    asAgent();
    const node = await (await createNode("To reject")).json();
    const eid = await createdEventId(node.id);

    asHuman();
    const res = await reject(eid);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe("rejected");
    expect(body.restore.restore_event_id).toBeTruthy();

    // NODE_CREATED inverse = soft delete: the node is now gone.
    const row = await q<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM content_nodes WHERE id = $1`, [node.id],
    );
    expect(row.rows[0]?.deleted_at).toBeTruthy();

    const inbox = await (await getInbox()).json();
    expect(inbox.events.find((e: { id: string }) => e.id === eid)).toBeUndefined();

    const again = await reject(eid);
    expect(again.status).toBe(409); // no undo/redo oscillation
  });

  it("404s for an unknown or non-agent event", async () => {
    asHuman();
    const humanNode = await (asHuman(), await (await createNode("Mine")).json());
    const humanEid = await createdEventId(humanNode.id);
    expect((await approve(humanEid)).status).toBe(404); // self-authored, not reviewable
    expect((await approve("999999999")).status).toBe(404);
  });

  // ── group decide over a triggered_by batch ─────────────────────────────────
  // (This coverage used to live in the RSS module test when feed arrivals were
  // agent batches; the staging rebuild removed those, so the generic behavior
  // is pinned here with a synthetic agent cascade: one marker root event + two
  // nested NODE_CREATEDs, the exact shape any tag-automation batch produces.)

  /** An agent-authored batch through the spine: root marker + N item creates
   *  chained via triggered_by (the inbox's grouping handle). */
  async function mkAgentBatch(label: string, n: number): Promise<{ rootId: string; nodeIds: string[] }> {
    const agentCtx: ActorCtx = { id: ids.agent, name: "Agent", role: "editor", type: "agent" };
    // The marker root must target a REAL node — the inbox redacts events whose
    // target isn't readable (the old feed batches rooted at their source node).
    asHuman();
    const host = (await (await createNode(`${label} host`)).json()) as { id: string };
    let rootId = "";
    const nodeIds: string[] = [];
    await mutate({
      actor: agentCtx,
      workspaceId,
      authority: { kind: "any_space_write" },
      event: {
        type: "AGENT_BATCH",
        targetType: "node",
        targetId: host.id,
        payload: { label, count: n },
      },
      apply: async ({ eventId }) => {
        rootId = eventId;
        for (let i = 0; i < n; i++) {
          const id = randomUUID();
          await mutate({
            actor: agentCtx,
            workspaceId,
            authority: { kind: "any_space_write" },
            event: {
              type: "NODE_CREATED",
              targetType: "node",
              targetId: id,
              payload: { title: `${label} ${i}` },
              txMeta: { inverse_op: "node.deleted" },
            },
            apply: async () => {
              await seedQ(
                `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
                 VALUES ($1, $2, 'manual', 'content', $3, $4, 'batch body')`,
                [id, workspaceId, `${label} ${i}`, `${label.toLowerCase().replace(/\s+/g, "-")}-${i}-${id.slice(0, 6)}`],
              );
            },
          });
          nodeIds.push(id);
        }
      },
    });
    return { rootId, nodeIds };
  }

  const groupDecide = (root: string, verb: "approve" | "reject") =>
    app.request(`/api/inbox/groups/${root}/${verb}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  it("group approve reviews the whole chain in one shot and is repeat-guarded", async () => {
    const { rootId } = await mkAgentBatch(`Batch approve ${Date.now()}`, 2);

    asHuman();
    const inbox = await (await getInbox()).json();
    const group = inbox.groups.find((g: { root_event_id: string }) => g.root_event_id === rootId);
    expect(group).toBeTruthy();
    expect(group.count).toBe(3); // 2 NODE_CREATED + the marker root itself

    const res = await groupDecide(rootId, "approve");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approved: number }).approved).toBe(3);

    // Gone from the queue; one attributed group EVENT_APPROVED exists.
    const after = await (await getInbox()).json();
    expect(after.groups.some((g: { root_event_id: string }) => g.root_event_id === rootId)).toBe(false);
    const audit = await q(
      `SELECT 1 FROM domain_events WHERE event_type = 'EVENT_APPROVED' AND target_id = $1 AND payload->>'group' = 'true'`,
      [rootId]);
    expect(audit.rows).toHaveLength(1);

    // Second decide → 404 (nothing unreviewed left in the chain).
    expect((await groupDecide(rootId, "approve")).status).toBe(404);
  });

  it("group reject inverse-undoes the batch (nodes soft-deleted, marker reviewed)", async () => {
    const { rootId, nodeIds } = await mkAgentBatch(`Batch reject ${Date.now()}`, 2);

    asHuman();
    const res = await groupDecide(rootId, "reject");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rejected: number; skipped: unknown[] };
    expect(body.rejected).toBe(3);
    expect(body.skipped).toHaveLength(0);

    // The created nodes are soft-deleted (NODE_CREATED's inverse)…
    const dead = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_nodes WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`,
      [nodeIds]);
    expect(Number(dead.rows[0]!.n)).toBe(2);
    // …and the whole chain left the queue (marker included).
    const after = await (await getInbox()).json();
    expect(after.groups.some((g: { root_event_id: string }) => g.root_event_id === rootId)).toBe(false);
  });

  it("group decide is principal-only: a delegated token is refused", async () => {
    const { rootId } = await mkAgentBatch(`Batch token ${Date.now()}`, 1);
    currentActor = {
      id: ids.human, name: "Human", role: "admin", type: "human",
      tokenScope: { tokenId: "inbox-tok-1", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
    };
    expect((await groupDecide(rootId, "approve")).status).toBe(403);
    asHuman();
  });
});

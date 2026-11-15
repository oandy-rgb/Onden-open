// Adversarial security verification (権限攻撃) against a real Postgres. Probes
// the spine's by-construction guarantees from the ATTACKER's side — not "does
// the happy path attribute correctly" (nodesSpine covers that) but "can a
// caller forge, inject, escalate, or cross a boundary?":
//
//   A. actor_type / actor_id cannot be forged via the request payload
//   B. SQL injection through event-query filters is neutralised (validate +
//      parameterise) — the table survives, no 500, no leak
//   C. cross-workspace isolation — you can't review another workspace's events
//   D. admin-only routes reject non-admins (tag schema edit)
//   E. governance self-review hole — an AGENT cannot approve/reject (only a
//      human reviews non-self-authored changes)
//   F. bearer-token tag scope is enforced at the spine, so REST can't bypass it
//
// SAFETY: only runs against a *_test database; skips otherwise.
//   DATABASE_URL=postgres://.../onden_test npx vitest run src/test/securityAttacks.integration.test.ts

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import inboxRouter from "../routes/inbox.js";
import tagsRouter from "../routes/tags.js";
import { assertAuthority } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api/events", eventsRouter);
app.route("/api/inbox", inboxRouter);
app.route("/api/tags", tagsRouter);

const json = (path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function createdEventId(nodeId: string): Promise<string> {
  const r = await q<{ id: string }>(
    `SELECT id::text FROM domain_events WHERE event_type='NODE_CREATED' AND target_id=$1 ORDER BY domain_events.id DESC LIMIT 1`,
    [nodeId],
  );
  return r.rows[0]!.id;
}

describe.skipIf(!isTestDb)("adversarial security (DB)", () => {
  let workspaceId: string;
  const ids = { human: "", agent: "", editor: "", viewer: "" };

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test', 'default')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
    const mk = async (name: string, type: string, role: string) => {
      const r = await q<{ id: string }>(
        `INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,$3) RETURNING id`,
        [workspaceId, name, type],
      );
      if (role === "admin") await setWorkspaceOwner(workspaceId, r.rows[0]!.id);
      return r.rows[0]!.id;
    };
    ids.human  = await mk("Human", "human", "admin");
    ids.agent  = await mk("Agent", "agent", "editor");
    ids.editor = await mk("Editor", "human", "editor");
    ids.viewer = await mk("Viewer", "human", "viewer");
    // membership is explicit since 097: everyone works in 共用 at their role
    await joinDefaultSpace(workspaceId, ids.human, "admin");
    await joinDefaultSpace(workspaceId, ids.agent, "editor");
    await joinDefaultSpace(workspaceId, ids.editor, "editor");
    await joinDefaultSpace(workspaceId, ids.viewer, "viewer");
  });

  const asHuman  = () => { currentActor = { id: ids.human,  name: "Human",  role: "admin",  type: "human" }; };
  const asAgent  = () => { currentActor = { id: ids.agent,  name: "Agent",  role: "editor", type: "agent" }; };
  const asEditor = () => { currentActor = { id: ids.editor, name: "Editor", role: "editor", type: "human" }; };

  // A. The classic injection: caller tries to set its own actor_type/actor_id in
  // the body. The spine DERIVES them from the authenticated actor and ignores
  // any such fields — so an agent can't masquerade as 'user' to slip past review.
  it("A. payload-injected actor_type / actor_id are ignored (derived, unforgeable)", async () => {
    asAgent();
    const res = await json("/api/nodes", "POST", {
      title: "forge attempt",
      markdown: "x",
      actor_type: "user",          // attacker-supplied — must be ignored
      actor_id: ids.human,         // attacker-supplied — must be ignored
    });
    expect(res.status).toBe(201);
    const node = await res.json();
    const ev = await q<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM domain_events WHERE event_type='NODE_CREATED' AND target_id=$1 ORDER BY id DESC LIMIT 1`,
      [node.id],
    );
    expect(ev.rows[0]?.actor_type).toBe("ai_agent"); // derived from the agent, not the body
    expect(ev.rows[0]?.actor_id).toBe(ids.agent);
  });

  // B. SQL injection through the event-query filters. since/limit are regex/int
  // validated; actor_type is an allowlist; the rest are bound parameters. None
  // of these should 500, drop the table, or return everything.
  it("B. SQL injection through /api/events filters is neutralised", async () => {
    asHuman();
    const before = await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events`);

    const drop = await json(`/api/events?actor_type=${encodeURIComponent("user';DROP TABLE domain_events;--")}`, "GET");
    expect(drop.status).toBe(400); // not an allowlisted actor_type

    const since = await json(`/api/events?since=${encodeURIComponent("1;DELETE FROM domain_events")}`, "GET");
    expect(since.status).toBe(400); // since must be \d+

    const tautology = await json(`/api/events?target_id=${encodeURIComponent("' OR '1'='1")}`, "GET");
    expect(tautology.status).toBe(200);
    const body = await tautology.json();
    // bound as a literal target_id → matches nothing, definitely not "everything"
    expect(body.events.every((e: { target_id: string }) => e.target_id === "' OR '1'='1")).toBe(true);

    const after = await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events`);
    expect(Number(after.rows[0]!.n)).toBeGreaterThanOrEqual(Number(before.rows[0]!.n)); // table intact, nothing deleted
  });

  // C. The inbox is workspace-scoped. An agent event living in ANOTHER workspace
  // must be invisible + un-reviewable from the default workspace context.
  it("C. cross-workspace events cannot be reviewed", async () => {
    const otherWs = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Other', 'other-ws')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    )).rows[0]!.id;
    const foreign = (await q<{ id: string }>(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
       VALUES ($1,'ai_agent','x','NODE_CREATED','content_node','deadbeef','{}') RETURNING id::text`,
      [otherWs],
    )).rows[0]!.id;

    asHuman();
    const inbox = await (await json("/api/inbox", "GET")).json();
    expect(inbox.events.find((e: { id: string }) => e.id === foreign)).toBeUndefined();
    expect((await json(`/api/inbox/${foreign}/approve`, "POST", {})).status).toBe(404);
    expect((await json(`/api/inbox/${foreign}/reject`, "POST", {})).status).toBe(404);
  });

  // D. Admin-only route: editing a tag's schema requires admin. An editor (human)
  // must be refused before any lookup.
  it("D. non-admin cannot edit a tag schema (admin route)", async () => {
    asEditor();
    const res = await json(`/api/tags/00000000-0000-0000-0000-000000000000/schema`, "PATCH", { fields: [] });
    expect(res.status).toBe(403);
  });

  // E. The governance hole: an agent must NOT be able to approve/reject — least
  // of all its own changes. Only a human reviews. (Regression guard for the gate
  // added to routes/inbox.ts.)
  it("E. reviewing is human + reviewer-role gated (agent / viewer / editor can't)", async () => {
    asAgent();
    const node = await (await json("/api/nodes", "POST", { title: "agent self-review", markdown: "x" })).json();
    const eid = await createdEventId(node.id);

    // agent (any role) — can't review its own changes (defeats the purpose)
    expect((await json(`/api/inbox/${eid}/approve`, "POST", {})).status).toBe(403);
    expect((await json(`/api/inbox/${eid}/reject`, "POST", {})).status).toBe(403);

    // human but role below reviewer — can read the queue, can't act
    asEditor(); // human, role 'editor' (< reviewer)
    expect((await json(`/api/inbox/${eid}/approve`, "POST", {})).status).toBe(403);

    // human reviewer/admin can
    asHuman(); // role 'admin'
    expect((await json(`/api/inbox/${eid}/approve`, "POST", {})).status).toBe(200);
  });

  // F. Bearer-token space scope is enforced at the spine — a token acting on a
  // note in a space its agent is not in is rejected, even via plain REST.
  it("F. a bearer token reaches only its agent's spaces: an op outside them is blocked (no REST bypass)", async () => {
    asHuman();
    const node = await (await json("/api/nodes", "POST", { title: "unscoped", markdown: "x" })).json();
    // An agent that is a member of no space: its token reaches nothing.
    const loner = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'No-space agent', 'agent') RETURNING id`, [workspaceId])).rows[0]!.id;
    const scopedAgent: ActorCtx = {
      id: loner, name: "Scoped", type: "agent",
      tokenScope: { tokenId: "t1", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    };
    await expect(
      assertAuthority(scopedAgent, { kind: "node", nodeId: node.id, op: "write_node" }),
    ).rejects.toThrow(); // the note's space is not one of the agent's
  });
});

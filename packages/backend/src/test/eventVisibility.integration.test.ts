// Who sees which event (services/eventVisibility.ts; pre-invite list item 1 in
// docs/archive/research/integration-audit-2026-10-13.md):
//   * an agent's tool call is audited without the text it wrote, and only the
//     owner and the agent itself see that audit event;
//   * a member does not see another member's workspace-level events;
//   * a sync delta does not name notes the reader could never hold.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import eventsRouter from "../routes/events.js";
import syncRouter from "../routes/sync.js";
import nodeRouter from "../routes/nodes.js";
import { callTool } from "../services/agentTools/index.js";
import { auditedToolArgs } from "../services/agentTools/registry.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/events", eventsRouter);
  app.route("/api/sync", syncRouter);
  app.route("/api/nodes", nodeRouter);
  return app;
}

type Event = { event_type: string; target_type: string; target_id: string; tx_meta: Record<string, unknown> | null };
// Scoped to this test's own actors/notes by the feed's filters: the shared
// test database holds other tests' events, some of them visible to anyone.
const feed = async (actor: ActorCtx, filter: string) =>
  ((await (await appFor(actor).request(`/api/events?limit=200&${filter}`)).json()) as { events: Event[] }).events;

describe("auditedToolArgs", () => {
  it("keeps argument names and the ids they name, never text", () => {
    expect(auditedToolArgs({ id: "n1", markdown: "my diary", title: "Secret", tag_ids: ["t1"], query: "divorce" }))
      .toEqual({ keys: ["id", "markdown", "title", "tag_ids", "query"], ids: { id: "n1", tag_ids: ["t1"] } });
    expect(auditedToolArgs({ nodeId: "n1", tagId: "t1" }).ids).toEqual({ nodeId: "n1", tagId: "t1" });
    expect(auditedToolArgs(undefined)).toEqual({ keys: [], ids: {} });
  });
});

describe.skipIf(!isTestDb)("event visibility", () => {
  let ws = "";
  let defaultSpace = "";
  const stamp = Date.now();
  const owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  const member: ActorCtx = { id: "", name: "Member", role: "editor", type: "human" };
  let agent: ActorCtx;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    Object.assign(member, await persistActor(ws, member));
    Object.assign(owner, await persistActor(ws, owner));
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    agent = await persistActor(ws, {
      id: "", name: `EV agent ${stamp}`, role: "editor", type: "agent",
      tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    // (persistActor already made the agent an editor of the default space.)
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [ws, `EV %${stamp}%`]);
    await pool.end();
  });

  it("an agent's tool call is audited without its text; the owner sees it, another member does not", async () => {
    const note = await (await appFor(owner).request("/api/nodes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `EV shared ${stamp}`, markdown: "", space_id: defaultSpace }),
    })).json() as { id: string };
    const secret = `agent wrote this ${stamp}`;
    await callTool("updateNode", { id: note.id, markdown: secret, base_markdown: "" }, { actor: agent, workspaceId: ws });

    const call = (await feed(owner, `actor_id=${agent.id}`)).find((e) => e.event_type === "AGENT_TOOL_CALLED" && e.target_id === "updateNode");
    expect(call).toBeTruthy();
    expect(JSON.stringify(call!.tx_meta)).not.toContain(secret);
    expect(call!.tx_meta?.args).toEqual({ keys: ["id", "markdown", "base_markdown"], ids: { id: note.id } });

    expect((await feed(member, `actor_id=${agent.id}`)).some((e) => e.event_type === "AGENT_TOOL_CALLED")).toBe(false);
    // The note's own history, readable to the note's readers, still shows the edit.
    expect((await feed(member, `target_id=${note.id}`)).some((e) => e.target_id === note.id && e.event_type === "NODE_UPDATED")).toBe(true);
  });

  it("a sync delta does not name a trashed note the reader could never hold", async () => {
    const since = Number((await q<{ id: string }>(`SELECT coalesce(max(id), 0)::text AS id FROM domain_events`)).rows[0]!.id);
    const mine = await (await appFor(owner).request("/api/nodes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `EV private ${stamp}`, markdown: "" }),
    })).json() as { id: string };
    expect((await appFor(owner).request(`/api/nodes/${mine.id}`, { method: "DELETE" })).status).toBeLessThan(300);

    const delta = async (actor: ActorCtx) =>
      (await (await appFor(actor).request(`/api/sync?since=${since}`)).json()) as { nodes: { delete: string[] } };
    expect((await delta(owner)).nodes.delete).toContain(mine.id);
    expect((await delta(member)).nodes.delete).not.toContain(mine.id);
  });
});

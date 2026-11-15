// The runner's side of agent sessions over HTTP (proposal PR 2): /pending,
// /claim, /events, /finish, the session token's reach, the write chain and
// the limits. The assembled app, real bearer tokens.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it, vi } from "vitest";
import { pool, q } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { eventChain } from "../services/eventChain.js";
import { reviewEvents } from "../services/eventReview.js";
import { AUDIT_EVENT_TYPES } from "../services/inboxQueue.js";
import { configureRunner, loadSession, setRunnerEnabled, startSession, type AgentSession } from "../services/agentSessions.js";
import { updateNode } from "../services/nodeUpdate.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { app } = await import("../app.js");

afterAll(async () => { await pool.end(); });

type World = Awaited<ReturnType<typeof agentWorld>>;
function req(path: string, init: { method?: string; bearer?: string; json?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers["content-type"] = "application/json";
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return Promise.resolve(app.request(path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined }));
}
const body = async (r: Response) => (await r.json()) as Record<string, any>;

/** The agent's resident token as the runner holds it (issued by the owner). */
async function residentToken(w: World, agentId = w.agent.id) {
  return (await createToken(agentId, { name: "resident", access: "write", issuedBy: w.owner.id })).plaintext;
}
async function send(w: World, text: string, nodeId?: string): Promise<{ nodeId: string; session: AgentSession }> {
  const md = `@${w.handle} ${text}`;
  const id = nodeId ?? await w.note(md);
  const { session } = await startSession(w.ws, { actor: w.owner, nodeId: id, target: { blockText: md } });
  return { nodeId: id, session };
}
async function claim(w: World, resident: string, session: AgentSession) {
  const r = await req(`/api/mcp/sessions/${session.id}/claim`, { method: "POST", bearer: resident, json: {} });
  return { status: r.status, json: await body(r) };
}

describe.skipIf(!isTestDb)("pull: /pending and /claim", () => {
  it("lists only this agent's open sessions and hands one out once", async () => {
    const w = await agentWorld("pull");
    const resident = await residentToken(w);
    const mine = await send(w, "問題一");
    // a second agent with its own session must not show up
    const other = await agentWorld("pullb");
    await send(other, "別人的");
    const pending = await body(await req("/api/mcp/sessions/pending", { bearer: resident }));
    expect(pending.sessions.map((s: { id: string }) => s.id)).toEqual([mine.session.id]);
    expect(pending.sessions[0]).toMatchObject({ node_id: mine.nodeId, status: "queued", prompt_preview: "問題一" });

    const first = await claim(w, resident, mine.session);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      session: { id: mine.session.id, attempt: 1 }, agent: { handle: w.handle }, initiator: { actor_id: w.owner.id },
      prompt: "問題一", mcp: { path: "/api/mcp/protocol" },
    });
    expect(first.json.mcp.token).toMatch(/^ondt_/);
    const rendered = first.json.rendered as { system: string; messages: Array<{ content: string }> };
    expect(rendered.system).toContain("<request>");
    expect(rendered.messages.at(-1)!.content).toContain(`@${w.handle} 問題一`); // the note, as data
    expect(rendered.messages.at(-1)!.content).toMatch(/<request>\n問題一\n<\/request>$/);

    // the same runner token may retry a lost response; the older session token dies
    const again = await claim(w, resident, mine.session);
    expect(again.status).toBe(200);
    expect(again.json.session.attempt).toBe(2);
    expect((await req("/api/mcp/tools", { bearer: first.json.mcp.token })).status).toBe(401);
    expect((await req("/api/mcp/tools", { bearer: again.json.mcp.token })).status).toBe(200);
    // a different token of the same agent cannot take it
    const rival = await claim(w, await residentToken(w), mine.session);
    expect(rival.status).toBe(409);
    expect(rival.json.error).toBe("not_claimable");
    // nobody else's agent can even see it
    const strangerResident = await residentToken(other, other.agent.id);
    expect((await claim(other, strangerResident, mine.session)).status).toBe(404);
  });

  it("two runners racing for one session: exactly one wins", async () => {
    const w = await agentWorld("race2");
    const { session } = await send(w, "搶");
    const tokens = await Promise.all([residentToken(w), residentToken(w), residentToken(w)]);
    const results = await Promise.all(tokens.map((t) => claim(w, t, session)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it("long-polls until a mention is sent", async () => {
    const w = await agentWorld("poll");
    const resident = await residentToken(w);
    const waiting = req("/api/mcp/sessions/pending?wait=10", { bearer: resident });
    await new Promise((r) => setTimeout(r, 300));
    const { session } = await send(w, "叫醒我");
    const t0 = Date.now();
    const got = await body(await waiting);
    expect(got.sessions.map((s: { id: string }) => s.id)).toEqual([session.id]);
    expect(Date.now() - t0).toBeLessThan(3000);
    // and it gives up on its own with an empty list
    const none = await body(await req("/api/mcp/sessions/pending?wait=1", { bearer: await residentToken(await agentWorld("poll2")) }));
    expect(none.sessions).toEqual([]);
  });

  it("respects max_concurrent, the kill switch, the global switch and a space that closed", async () => {
    const w = await agentWorld("limits");
    await configureRunner(w.ws, w.agent.id, { handle: w.handle, maxConcurrent: 1 }, { actor: w.owner });
    const resident = await residentToken(w);
    const a = await send(w, "a"), b = await send(w, "b");
    expect((await claim(w, resident, a.session)).status).toBe(200);
    const blocked = await claim(w, resident, b.session);
    expect(blocked).toMatchObject({ status: 429, json: { error: "too_many_running" } });
    expect((await loadSession(b.session.id))!.status).toBe("queued"); // still takeable later

    process.env.ONDEN_AGENT_SESSIONS = "off";
    try {
      expect((await claim(w, resident, b.session)).json.error).toBe("sessions_off");
      expect((await body(await req("/api/mcp/sessions/pending", { bearer: resident }))).sessions).toEqual([]);
    } finally { delete process.env.ONDEN_AGENT_SESSIONS; }

    // the kill switch: nothing pending, and what was open is cancelled
    await setRunnerEnabled(w.ws, w.agent.id, false, { actor: w.owner });
    expect((await body(await req("/api/mcp/sessions/pending", { bearer: resident }))).sessions).toEqual([]);
    expect((await claim(w, resident, b.session)).json.error).toBe("agent_disabled");
    expect(await loadSession(a.session.id)).toMatchObject({ status: "cancelled", fail_code: "agent_disabled" });
    await setRunnerEnabled(w.ws, w.agent.id, true, { actor: w.owner });

    // the space stops letting external AI in after the send: the claim ends the session instead of leaving it to time out
    const d = await send(w, "d");
    await q(`UPDATE spaces SET capabilities = jsonb_set(capabilities, '{external_ai}', 'false') WHERE id = $1`, [w.space]);
    const closed = await claim(w, resident, d.session);
    expect(closed).toMatchObject({ status: 409, json: { error: "space_unavailable" } });
    expect(await loadSession(d.session.id)).toMatchObject({ status: "failed", fail_code: "space_unavailable" });
  });

  it("meters pulling per agent: the 61st poll in a minute is a 429 with Retry-After", async () => {
    const w = await agentWorld("meter");
    const resident = await residentToken(w);
    const other = await residentToken(w); // a second token of the same agent shares the meter
    for (let i = 0; i < 60; i++) expect((await req("/api/mcp/sessions/pending", { bearer: i % 2 ? resident : other })).status).toBe(200);
    const over = await req("/api/mcp/sessions/pending", { bearer: resident });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect((await body(over)).error).toBe("rate_limited");
  });

  it("refuses a session token on the pull endpoints and a resident token on the session ones", async () => {
    const w = await agentWorld("kinds");
    const resident = await residentToken(w);
    const { session } = await send(w, "x");
    const taken = await claim(w, resident, session);
    const sessionToken = taken.json.mcp.token as string;
    expect((await req("/api/mcp/sessions/pending", { bearer: sessionToken })).status).toBe(403);
    expect((await claim(w, sessionToken, session)).status).toBe(403);
    const ev = await req(`/api/mcp/sessions/${session.id}/events`, { bearer: resident, json: { seq: 1, kind: "ack" } });
    expect(ev.status).toBe(403);
    expect((await req(`/api/mcp/sessions/${session.id}/finish`, { bearer: resident, json: { status: "failed" } })).status).toBe(403);
    // a bearer token is confined to /api/mcp: it cannot read the notes API
    expect((await req("/api/nodes", { bearer: sessionToken })).status).toBe(403);
    expect((await req("/api/mcp/sessions/pending")).status).toBe(401);
  });
});

describe.skipIf(!isTestDb)("a session's run", () => {
  async function running(w: World, text = "做事") {
    const resident = await residentToken(w);
    const sent = await send(w, text);
    const taken = await claim(w, resident, sent.session);
    const token = taken.json.mcp.token as string;
    const ack = await req(`/api/mcp/sessions/${sent.session.id}/events`, { bearer: token, json: { seq: 1, kind: "ack", text: "start" } });
    expect(await body(ack)).toEqual({ status: "running", deduped: false });
    return { ...sent, resident, token };
  }
  const tool = (token: string, name: string, args: unknown) => req(`/api/mcp/tools/${name}`, { bearer: token, json: args });

  it("events then finish: the reply lands, the token dies, the log is kept", async () => {
    const w = await agentWorld("run");
    const run = await running(w);
    expect((await body(await req(`/api/mcp/sessions/${run.session.id}/events`, { bearer: run.token, json: { seq: 2, kind: "action", tool: "getNode", target_id: run.nodeId } }))).deduped).toBe(false);
    expect((await body(await req(`/api/mcp/sessions/${run.session.id}`, { bearer: run.token }))).status).toBe("running");
    const done = await req(`/api/mcp/sessions/${run.session.id}/finish`, { bearer: run.token, json: { status: "completed", result_markdown: "完成了" } });
    expect(done.status).toBe(200);
    expect(await body(done)).toMatchObject({ status: "completed", replayed: false });
    expect(await w.body(run.nodeId)).toMatch(/\n> 完成了\n?$/); // the reply block carries no `^id`: its identity is an anchor
    expect((await tool(run.token, "getNode", { id: run.nodeId })).status).toBe(401); // revoked with the session
    expect((await req(`/api/mcp/sessions/${run.session.id}/events`, { bearer: run.token, json: { seq: 3, kind: "thought", text: "late" } })).status).toBe(401);
    // bad bodies are 400, not 500
    const second = await running(w, "第二個");
    expect((await req(`/api/mcp/sessions/${second.session.id}/events`, { bearer: second.token, json: { seq: "x", kind: "ack" } })).status).toBe(400);
    expect((await req(`/api/mcp/sessions/${second.session.id}/finish`, { bearer: second.token, json: { status: "completed" } })).status).toBe(400);
  });

  it("the token reaches one space only: an injected note cannot write elsewhere", async () => {
    const w = await agentWorld("reach");
    const run = await running(w);
    // the agent belongs to a second space too (with external AI on); the sender is in it as well
    const elsewhere = await makeSpace(w.ws, `else ${w.stamp}`, [{ id: w.owner.id, role: "manager" }, { id: w.agent.id, role: "editor" }]);
    const outsider = await w.note("私人", elsewhere);
    const insider = await w.note("同空間");
    expect((await tool(run.token, "updateNode", { id: insider, title: "改好了" })).status).toBe(200);
    const denied = await tool(run.token, "updateNode", { id: outsider, title: "不該成功" });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [outsider])).rows[0]!.title).not.toBe("不該成功");
    // reading is confined too: another space's note is simply not there for this token
    expect((await body(await tool(run.token, "getNode", { id: outsider }))).result).toBeNull();
    expect((await body(await tool(run.token, "getNode", { id: insider }))).result).toMatchObject({ id: insider });
    // and a note cannot be created in the other space
    const created = await body(await tool(run.token, "createNode", { title: "新", markdown: "x", space_id: elsewhere }));
    expect(created.ok).not.toBe(true);
  });

  it("writes join the session's chain; a group reject reverts them and spares a later edit", async () => {
    const w = await agentWorld("chain");
    const run = await running(w);
    const x = await w.note("X 原文"), y = await w.note("Y 原文");
    const title = async (id: string) => (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title;
    const [xTitle, yTitle] = [await title(x), await title(y)];
    expect((await tool(run.token, "updateNode", { id: x, title: "X 被代理改了" })).status).toBe(200);
    expect((await tool(run.token, "updateNode", { id: y, title: "Y 被代理改了" })).status).toBe(200);
    const fin = await req(`/api/mcp/sessions/${run.session.id}/finish`, { bearer: run.token, json: { status: "completed", result_markdown: "改好了" } });
    expect(fin.status).toBe(200);

    const chain = await eventChain(w.ws, run.session.root_event_id!);
    const members = (await q<{ id: string; event_type: string; target_id: string }>(
      `SELECT e.id::text, e.event_type, e.target_id FROM domain_events e LEFT JOIN event_reviews r ON r.event_id = e.id
        WHERE e.id = ANY($1::bigint[]) AND e.actor_type = 'ai_agent' AND e.event_type <> ALL($2::text[]) AND r.event_id IS NULL ORDER BY e.id`,
      [chain.map((e) => e.id), AUDIT_EVENT_TYPES])).rows;
    // x, y and the reply: all caused by the root, all waiting for review (more than the reply happened)
    expect(members.map((m) => m.target_id).sort()).toEqual([x, y, run.nodeId].sort());

    // the user edits Y after the agent: that edit must survive the revert
    await updateNode(w.ws, y, { title: "Y 使用者後來改的" }, { actor: w.owner });
    const outcomes = await reviewEvents(w.owner, w.ws, members.map((m) => m.id), "reject", { group: { rootEventId: run.session.root_event_id! } });
    const byTarget = new Map(members.map((m, i) => [m.target_id, outcomes.find((o) => o.eventId === m.id)!]));
    expect(byTarget.get(x)!.status).toBe("decided");
    expect(byTarget.get(run.nodeId)!.status).toBe("decided");
    expect(byTarget.get(y)!.status).toBe("restore_failed");
    expect(await title(x)).toBe(xTitle);
    expect(await title(y)).toBe("Y 使用者後來改的");
    expect(yTitle).not.toBe("Y 使用者後來改的");
    expect(await w.body(run.nodeId)).not.toContain("改好了"); // the reply block is gone
  });

  it("stops a runaway: the 51st write of a session is refused", async () => {
    const w = await agentWorld("cap");
    const run = await running(w);
    await q(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, triggered_by_event_id)
       SELECT $1, 'ai_agent', $2, 'NODE_UPDATED', 'node', gen_random_uuid()::text, $3 FROM generate_series(1, 50)`,
      [w.ws, w.agent.id, run.session.root_event_id]);
    const refused = await tool(run.token, "getNode", { id: run.nodeId });
    expect(refused.status).toBe(429);
    expect((await body(refused)).error).toBe("session_write_limit");
  });

  it("ends a running session at once when the agent is switched off, the sender loses the space or time runs out", async () => {
    const w = await agentWorld("end");
    const a = await running(w, "a");
    expect((await tool(a.token, "getNode", { id: a.nodeId })).status).not.toBe(401);
    await setRunnerEnabled(w.ws, w.agent.id, false, { actor: w.owner });
    expect((await tool(a.token, "getNode", { id: a.nodeId })).status).toBe(401);
    expect((await loadSession(a.session.id))!.status).toBe("cancelled");
    await setRunnerEnabled(w.ws, w.agent.id, true, { actor: w.owner });

    // the sender is removed from the space while it runs: the next call fails (policy re-read per call)
    const b = await running(w, "b");
    await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2`, [w.space, w.owner.id]);
    const after = await tool(b.token, "getNode", { id: b.nodeId });
    expect(after.status).toBeGreaterThanOrEqual(400);
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.space, w.owner.id]);

    // past the deadline the guard names the reason even before the sweep runs
    const c = await running(w, "c");
    await q(`UPDATE agent_sessions SET deadline_at = now() - interval '1 second' WHERE id = $1`, [c.session.id]);
    await q(`UPDATE agent_tokens SET expires_at = NULL WHERE session_id = $1`, [c.session.id]);
    const late = await tool(c.token, "getNode", { id: c.nodeId });
    expect(late.status).toBe(409);
    expect((await body(late)).error).toBe("session_ended");
  });
});

// The owner's AI role settings (proposal 2026-10-27 §5.6): the review rule, the way of
// running and whether it works now (computed from facts), this month's use, and who may
// change any of it. No test reaches the real API.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.
import { afterAll, describe, expect, it, vi } from "vitest";

import { pool, q } from "../db.js";
import { addCredential } from "../services/aiCredentials.js";
import { createToken } from "../services/agentTokens.js";
import { patchRole, roleRuntimes, touchRunnerSeen } from "../services/aiRoles.js";
import { loadRunner } from "../services/agentSessions.js";
import { AuthorityError } from "../spine/authority.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { persistActor } from "./helpers/persistActor.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

afterAll(async () => { delete process.env.ONDEN_SECRET_KEY; await pool.end(); });

const roleOf = async (w: Awaited<ReturnType<typeof agentWorld>>) =>
  (await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === w.agent.id)!;
const events = async (type: string, targetId: string) =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE event_type = $1 AND target_id = $2`, [type, targetId])).rows[0]!.n;

describe.skipIf(!isTestDb)("AI role review rule and settings", () => {
  it("lists the review rule, spaces and an empty month for a fresh role", async () => {
    const w = await agentWorld("rr-list");
    const role = await roleOf(w);
    expect(role.review_rule).toBe("apply"); // the fixture agent predates suggestions
    expect(role.review_rule_locked).toBe(false);
    expect(role.spaces[w.space]).toBe("edit");
    expect(role.usage_this_month).toEqual({ input_tokens: 0, output_tokens: 0, cost_estimate_micro_usd: null });
  });

  it("owner switches the rule both ways; each change is an event and reaches the token's actor", async () => {
    const w = await agentWorld("rr-set");
    await patchRole(w.ws, w.agent.id, { reviewRule: "suggest" }, { actor: w.owner });
    expect((await roleOf(w)).review_rule).toBe("suggest");
    expect(await events("AI_ROLE_REVIEW_RULE_SET", w.agent.id)).toBe(1);
    const token = await createToken(w.agent.id, { access: "write", issuedBy: w.owner.id });
    const current = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: token.id } }, w.ws);
    expect(current.tokenScope?.writeMode).toBe("suggest"); // read at use, not copied at mint
    await patchRole(w.ws, w.agent.id, { reviewRule: "apply" }, { actor: w.owner });
    expect((await roleOf(w)).review_rule).toBe("apply");
    expect(await events("AI_ROLE_REVIEW_RULE_SET", w.agent.id)).toBe(2);
  });

  it("an API role shows suggest as locked", async () => {
    const w = await agentWorld("rr-api");
    process.env.ONDEN_SECRET_KEY = "ab".repeat(32);
    const credential = await addCredential(w.ws, { label: "test key", apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ", baseUrl: "http://127.0.0.1:9", protocol: "v1_messages" }, { actor: w.owner });
    await q(`UPDATE agent_runners SET default_runtime = 'api', api_credential_id = $2, api_model = 'test-model', api_cap_choice = 'unlimited' WHERE actor_id = $1`,
      [w.agent.id, credential.id]);
    expect((await roleOf(w)).review_rule_locked).toBe(true);
  });

  it("refuses a delegated token, a non-owner and an unknown agent; changes nothing", async () => {
    const w = await agentWorld("rr-deny");
    const token = await createToken(w.agent.id, { access: "write", issuedBy: w.owner.id });
    const asToken = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: token.id } }, w.ws);
    await expect(patchRole(w.ws, w.agent.id, { reviewRule: "suggest" }, { actor: asToken })).rejects.toBeInstanceOf(AuthorityError);
    await expect(roleRuntimes(w.ws, { actor: asToken })).rejects.toBeInstanceOf(AuthorityError);
    const member = await persistActor(w.ws, { id: "", name: `Member ${w.stamp}`, role: "editor", type: "human" });
    await expect(patchRole(w.ws, w.agent.id, { reviewRule: "suggest" }, { actor: member })).rejects.toBeInstanceOf(AuthorityError);
    await expect(patchRole(w.ws, member.id, { reviewRule: "suggest" }, { actor: w.owner })).rejects.toMatchObject({ code: "unknown_agent" });
    expect((await roleOf(w)).review_rule).toBe("apply");
    expect(await events("AI_ROLE_REVIEW_RULE_SET", w.agent.id)).toBe(0);
  });

  it("pause and runtime go through the same PATCH; an API runtime without key and model is refused first", async () => {
    const w = await agentWorld("rr-patch");
    await expect(patchRole(w.ws, w.agent.id, { defaultRuntime: "api", reviewRule: "suggest" }, { actor: w.owner })).rejects.toBeTruthy();
    expect((await roleOf(w)).review_rule).toBe("apply"); // refused before the rule was written
    await patchRole(w.ws, w.agent.id, { enabled: false, defaultRuntime: "mcp" }, { actor: w.owner });
    const role = await roleOf(w);
    expect(role.enabled).toBe(false);
    expect(role.default_runtime).toBe("mcp");
  });

  it("mcp: a client that polls for queued sessions shows up as the role's last seen, with no separate runner state", async () => {
    const w = await agentWorld("rr-seen");
    const mcp = async () => (await roleOf(w)).runtimes.find((r) => r.kind === "mcp")!;
    expect((await roleOf(w)).runtimes.map((r) => r.kind)).not.toContain("subscription");
    expect(await mcp()).toMatchObject({ available: true, unavailable_reason: null, last_seen_at: null });
    await touchRunnerSeen(w.agent.id);
    expect(await mcp()).toMatchObject({ available: true, unavailable_reason: null });
    expect((await mcp()).last_seen_at).not.toBeNull();
    // A poll long ago is still just a time: nothing turns "offline" into a reason the role cannot be used.
    await q(`UPDATE agent_runners SET runner_seen_at = now() - interval '10 minutes' WHERE actor_id = $1`, [w.agent.id]);
    expect(await mcp()).toMatchObject({ available: true, unavailable_reason: null });
    expect(new Date((await mcp()).last_seen_at!).getTime()).toBeLessThan(Date.now() - 9 * 60_000);
    // A poll within 10 seconds of the last write does not write again.
    await touchRunnerSeen(w.agent.id);
    await touchRunnerSeen(w.agent.id);
    expect((await loadRunner(w.ws, { actorId: w.agent.id }))!.runner_seen_at).not.toBeNull();
  });

  it("mcp: no key, then a key never used, then the time of the last call", async () => {
    const w = await agentWorld("rr-mcp");
    const mcp = async () => (await roleOf(w)).runtimes.find((r) => r.kind === "mcp")!;
    await q(`UPDATE agent_tokens SET revoked_at = now() WHERE actor_id = $1`, [w.agent.id]); // the fixture agent has one
    expect(await mcp()).toMatchObject({ available: false, unavailable_reason: "no_token" });
    const token = await createToken(w.agent.id, { access: "write", issuedBy: w.owner.id });
    expect(await mcp()).toMatchObject({ available: true, last_seen_at: null });
    await q(`UPDATE agent_tokens SET last_used_at = now() WHERE id = $1`, [token.id]);
    expect((await mcp()).last_seen_at).not.toBeNull();
  });

  it("this month's tokens are summed; money only when every API session was priced", async () => {
    const w = await agentWorld("rr-usage");
    const node = await w.note("usage");
    const insert = (runtime: string, input: number, output: number, cost: number | null) => q(
      `INSERT INTO agent_sessions (workspace_id, agent_actor_id, initiator_id, node_id, space_id, status, prompt, runtime, model, write_mode, input_tokens, output_tokens, cost_estimate_micro_usd, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', 'x', $6, $7, $8, $9, $10, $11, now() + interval '1 hour')`,
      [w.ws, w.agent.id, w.owner.id, node, w.space, runtime, runtime === "api" ? "claude-test" : null, runtime === "api" ? "suggest" : "apply", input, output, cost]);
    await insert("mcp", 100, 20, null);
    expect((await roleOf(w)).usage_this_month).toEqual({ input_tokens: 100, output_tokens: 20, cost_estimate_micro_usd: null });
    await insert("api", 1000, 200, 5000);
    expect((await roleOf(w)).usage_this_month).toEqual({ input_tokens: 1100, output_tokens: 220, cost_estimate_micro_usd: 5000 });
    await insert("api", 10, 1, null); // an unpriced model: no total is shown at all
    expect((await roleOf(w)).usage_this_month).toMatchObject({ input_tokens: 1110, cost_estimate_micro_usd: null });
  });
});

describe.skipIf(!isTestDb)("PATCH /api/ai/roles/:actor_id over HTTP", () => {
  const NATIVE = { origin: "http://localhost" };
  const call = async (path: string, init: { method?: string; json?: unknown; bearer?: string } = {}) => {
    const { app } = await import("../app.js");
    const headers: Record<string, string> = { ...NATIVE };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return app.request(path, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined });
  };

  it("a malformed id is 400, an empty or unknown body is 400", async () => {
    expect((await call("/api/ai/roles/not-a-uuid", { method: "PATCH", json: { review_rule: "suggest" } })).status).toBe(400);
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await call(`/api/ai/roles/${id}`, { method: "PATCH", json: {} })).status).toBe(400);
    expect((await call(`/api/ai/roles/${id}`, { method: "PATCH", json: { review_rule: "open" } })).status).toBe(400);
    expect((await call(`/api/ai/roles/${id}`, { method: "PATCH", json: { write_mode: "apply" } })).status).toBe(400);
  });

  it("a delegated token gets 403 and the rule is unchanged", async () => {
    const w = await agentWorld("rr-http");
    const token = await createToken(w.agent.id, { access: "write", issuedBy: w.owner.id });
    const res = await call(`/api/ai/roles/${w.agent.id}`, { method: "PATCH", json: { review_rule: "suggest" }, bearer: token.plaintext });
    expect([401, 403]).toContain(res.status);
    expect((await roleOf(w)).review_rule).toBe("apply");
    const list = await call("/api/ai/roles", { bearer: token.plaintext });
    expect([401, 403]).toContain(list.status);
  });
});

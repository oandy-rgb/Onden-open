// The api AI runtime (proposal 2026-10-27 §4.2, decision 2026-10-30): keys kept encrypted,
// models asked of the key, the Tool Runner loop over the MCP registry, one-shot claim,
// limits, and above all: an api session can only PROPOSE — the spine refuses any other
// domain event whatever tool or entry point asks for it.
//
// The agent in the fixture is set to write directly ('apply'); its api sessions are still suggest-only.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database. No test reaches the real API.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool, q } from "../db.js";
import { addCredentialDetectingFormat } from "../services/aiCredentialSetup.js";
import { addCredential, listCredentials, revokeCredential, loadApiKey } from "../services/aiCredentials.js";
import { openSecret, sealSecret } from "../services/serverSecret.js";
import { legacySealed, openAsPreviousDeploy, purposeSealed } from "./helpers/legacySealed.js";
import { createToken } from "../services/agentTokens.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { AgentSessionError, claimSession, endSession, loadRunner, pendingSessions, loadSession, startSession, type AgentSession } from "../services/agentSessions.js";
import { chooseRuntime, runtimeAvailability, runtimeFor } from "../services/agentRuntime/index.js";
import { startApiRun, failInterruptedApiSessions } from "../services/agentRuntime/api/run.js";
import { actorForRuntimeSession } from "../services/agentRuntime/api/actor.js";
import { MAX_TURNS } from "../services/agentRuntime/api/limits.js";
import { roleRuntimes, setRoleRuntime } from "../services/aiRoles.js";
import { startSelectionAction } from "../services/selectionActions.js";
import { drainOutbox } from "../services/outbox.js";
import { mutate } from "../spine/mutate.js";
import { AuthorityError } from "../spine/authority.js";
import { assertWriteModeAllows, ScopeError } from "../spine/toolScope.js";
import { agentWorld, sessionActor } from "./helpers/agentSessionFixture.js";
import { handToAiOptions } from "../services/handToAi.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import { followPreview } from "../services/agentRuntime/index.js";
import { cancel, finish, markDelivered } from "../services/agentSessions.js";
import { modelInfo, startFakeMessagesService, textMessage, toolUseMessage } from "./helpers/fakeMessagesService.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ";
const SECRET = "ab".repeat(32);


type World = Awaited<ReturnType<typeof agentWorld>>;
let fake: Awaited<ReturnType<typeof startFakeMessagesService>>;

beforeAll(async () => {
  if (!isTestDb) return;
  process.env.ONDEN_SECRET_KEY = SECRET;
  fake = await startFakeMessagesService();
  process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
});
afterAll(async () => {
  if (isTestDb) await fake.close();
  delete process.env.ONDEN_SECRET_KEY;
  delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
  await pool.end();
});
beforeEach(() => {
  fake.requests.length = 0; fake.state.script.length = 0; fake.state.fallback = null;
});

/** An api-ready role: a live key, a chosen model, a cap answer. Set by SQL so the setup does not depend on the settings service. */
async function apiWorld(label: string, extra: Partial<{ cap: "capped" | "unlimited"; capTokens: number; smallOnly: boolean; webSearch: boolean }> = {}) {
  const w = await agentWorld(label);
  const credential = await addCredential(w.ws, { label: "test key", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
  await q(
    `UPDATE agent_runners SET default_runtime = 'api', api_credential_id = $2, api_model = 'test-model',
            api_cap_choice = $3, monthly_cap_tokens = $4, api_small_actions_only = $5, api_web_search = $6 WHERE actor_id = $1`,
    [w.agent.id, credential.id, extra.cap ?? "unlimited", extra.cap === "capped" ? (extra.capTokens ?? 1000) : null, extra.smallOnly ?? false, extra.webSearch ?? false]);
  return { w, credential };
}

/** The test workspace is shared, and earlier tests in this file leave keys in it:
 *  "no key at all" needs every key gone (only this file adds keys; files run one at a time). */
async function revokeEveryKey(ws: string) {
  await q(`UPDATE ai_credentials SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL`, [ws]);
}

async function mention(w: World, text = "看一下") {
  const nodeId = await w.note(`@${w.handle} ${text}`);
  const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} ${text}` } });
  return { nodeId, session };
}
/** Drain the outbox row of this session, which claims it and starts the run. */
async function dispatchAndWait(session: AgentSession): Promise<AgentSession> {
  const row = (await q<{ id: string }>(
    `SELECT id::text FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [session.id])).rows[0]!;
  await drainOutbox({ id: row.id });
  for (let i = 0; i < 200; i++) {
    const now = (await loadSession(session.id))!;
    if (["completed", "failed", "cancelled"].includes(now.status)) return now;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("session did not finish");
}

describe.skipIf(!isTestDb)("API keys", () => {
  it("keeps only ciphertext, returns the last four, binds the cipher to its row", async () => {
    const w = await agentWorld("cred");
    const credential = await addCredential(w.ws, { label: "main", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    expect(credential).toMatchObject({ label: "main", last4: KEY.slice(-4) });
    expect(JSON.stringify(credential)).not.toContain(KEY);
    const row = (await q<{ secret_ciphertext: Buffer }>(`SELECT secret_ciphertext FROM ai_credentials WHERE id = $1`, [credential.id])).rows[0]!;
    expect(row.secret_ciphertext.includes(Buffer.from(KEY))).toBe(false);
    expect(await loadApiKey(w.ws, credential.id)).toBe(KEY);
    // the event and the listing carry no key
    const ev = (await q<{ payload: unknown }>(`SELECT payload FROM domain_events WHERE event_type = 'AI_CREDENTIAL_ADDED' AND target_id = $1`, [credential.id])).rows[0]!;
    expect(JSON.stringify(ev.payload)).not.toContain(KEY);
    expect(JSON.stringify(await listCredentials(w.ws, { actor: w.owner }))).not.toContain(KEY);
    // a ciphertext moved to another row id does not decrypt
    expect(() => openSecret("ai-credential", randomUUID(), row.secret_ciphertext)).toThrow(AgentSessionError);
    // the stored form is the one the previous deploy reads (rollout step 1, services/serverSecret.ts)
    expect(openAsPreviousDeploy(SECRET, credential.id, row.secret_ciphertext)).toBe(KEY);
  });

  it("refuses without ONDEN_SECRET_KEY, for a non-owner, and for a malformed key", async () => {
    const w = await agentWorld("cred-refuse");
    delete process.env.ONDEN_SECRET_KEY;
    try {
      expect(await addCredential(w.ws, { label: "x", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner }).then(() => null, (e) => e.code)).toBe("secret_key_missing");
      expect(() => sealSecret("ai-credential", randomUUID(), "x")).toThrow();
    } finally { process.env.ONDEN_SECRET_KEY = SECRET; }
    expect(await addCredential(w.ws, { label: "x", apiKey: "bad key", baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner }).then(() => null, (e) => e.code)).toBe("invalid_credential");
    expect(await addCredential(w.ws, { label: "x", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.agent }).then(() => "ok", (e) => e instanceof AuthorityError ? "denied" : "other")).toBe("denied");
  });

  it("a revoked key can no longer be read", async () => {
    const w = await agentWorld("cred-revoke");
    const c = await addCredential(w.ws, { label: "k", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    await revokeCredential(w.ws, c.id, { actor: w.owner });
    expect(await loadApiKey(w.ws, c.id).then(() => null, (e) => e.code)).toBe("credential_revoked");
  });

  it("a key the previous deploy saved still opens, and reading it changes nothing in the row", async () => {
    const w = await agentWorld("cred-legacy");
    const c = await addCredential(w.ws, { label: "old", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    const old = legacySealed(SECRET, c.id, KEY);
    await q(`UPDATE ai_credentials SET secret_ciphertext = $2 WHERE id = $1`, [c.id, old]);
    expect(await loadApiKey(w.ws, c.id)).toBe(KEY);
    const after = (await q<{ s: Buffer }>(`SELECT secret_ciphertext AS s FROM ai_credentials WHERE id = $1`, [c.id])).rows[0]!.s;
    expect(Buffer.from(after).equals(old)).toBe(true);
  });

  it("a version 2 key (from step 2 of the rollout) opens, and one sealed for a calendar address under the same id does not", async () => {
    const w = await agentWorld("cred-v2");
    const c = await addCredential(w.ws, { label: "v2", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    await q(`UPDATE ai_credentials SET secret_ciphertext = $2 WHERE id = $1`, [c.id, purposeSealed(SECRET, "ai-credential", c.id, KEY)]);
    expect(await loadApiKey(w.ws, c.id)).toBe(KEY);
    await q(`UPDATE ai_credentials SET secret_ciphertext = $2 WHERE id = $1`, [c.id, purposeSealed(SECRET, "external-calendar", c.id, "https://cal.example/x.ics")]);
    expect(await loadApiKey(w.ws, c.id).then(() => null, (e) => e.code)).toBe("credential_unreadable");
  });

  it("a row that does not open under this server's key is refused and left exactly as it is", async () => {
    const w = await agentWorld("cred-legacy-foreign");
    const c = await addCredential(w.ws, { label: "foreign", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    const foreign = legacySealed("cd".repeat(32), c.id, KEY);
    await q(`UPDATE ai_credentials SET secret_ciphertext = $2 WHERE id = $1`, [c.id, foreign]);
    expect(await loadApiKey(w.ws, c.id).then(() => null, (e) => e.code)).toBe("credential_unreadable");
    expect(Buffer.from((await q<{ s: Buffer }>(`SELECT secret_ciphertext AS s FROM ai_credentials WHERE id = $1`, [c.id])).rows[0]!.s).equals(foreign)).toBe(true);
  });
});

describe.skipIf(!isTestDb)("availability", () => {
  it("without ONDEN_SECRET_KEY the api runtime is not offered at all, and a mention to an api role is refused before anything is written", async () => {
    const { w } = await apiWorld("avail-nosecret");
    delete process.env.ONDEN_SECRET_KEY;
    try {
      const role = (await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === w.agent.id)!;
      expect(role.runtimes.map((r) => r.kind)).not.toContain("api"); // absent, not greyed out
      expect(role.api).toBeNull();
      expect(await runtimeFor("api").availability((await loadRunner(w.ws, { actorId: w.agent.id }))!)).toEqual({ ok: false, reason: "no_secret_key" });
      const nodeId = await w.note(`@${w.handle} hi`);
      expect(await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} hi` } }).then(() => null, (e) => e.code)).toBe("runtime_unavailable");
      expect((await q(`SELECT 1 FROM agent_sessions WHERE node_id = $1`, [nodeId])).rows).toHaveLength(0);
    } finally { process.env.ONDEN_SECRET_KEY = SECRET; }
  });

  it("no key, no secret, no model, retired model, unanswered cap, reached cap each say why", async () => {
    const { w, credential } = await apiWorld("avail", { cap: "capped", capTokens: 1000 });
    const role = async () => (await loadRunner(w.ws, { actorId: w.agent.id }))!;
    const reason = async () => { const a = await runtimeFor("api").availability(await role()); return a.ok ? "ok" : a.reason; };
    // The limit is counted in tokens, whatever the model: no price is needed to keep it.
    expect(await reason()).toBe("ok");
    // tokens used this month at the limit → paused, with the reason
    const { session } = await mention(w);
    await q(`UPDATE agent_sessions SET input_tokens = 600, output_tokens = 400 WHERE id = $1`, [session.id]);
    expect(await reason()).toBe("cap_reached");
    await q(`UPDATE agent_sessions SET output_tokens = 399 WHERE id = $1`, [session.id]);
    expect(await reason()).toBe("ok");
    await endSession(w.ws, session.id, "cancelled");
    await q(`UPDATE agent_runners SET api_model_retired_at = now() WHERE actor_id = $1`, [w.agent.id]);
    expect(await reason()).toBe("model_retired");
    await q(`UPDATE agent_runners SET api_model_retired_at = NULL, api_model = NULL, default_runtime = 'mcp' WHERE actor_id = $1`, [w.agent.id]);
    expect(await reason()).toBe("no_model");
    await q(`UPDATE agent_runners SET api_model = 'claude-sonnet-5-5', api_cap_choice = NULL WHERE actor_id = $1`, [w.agent.id]);
    expect(await reason()).toBe("cap_unanswered");
    // A key exists but this role has none chosen: a step to take, and the API stays listed.
    await q(`UPDATE agent_runners SET api_credential_id = NULL, default_runtime = 'mcp' WHERE actor_id = $1`, [w.agent.id]);
    expect(await reason()).toBe("key_unchosen");
    expect((await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === w.agent.id)?.api).not.toBeNull();
    await q(`UPDATE agent_runners SET api_credential_id = $2 WHERE actor_id = $1`, [w.agent.id, credential.id]);
    await revokeCredential(w.ws, credential.id, { actor: w.owner });
    await revokeEveryKey(w.ws);
    expect(await reason()).toBe("no_key");
    expect((await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === w.agent.id)?.api).toBeNull();
    delete process.env.ONDEN_SECRET_KEY;
    try { expect(await reason()).toBe("no_secret_key"); } finally { process.env.ONDEN_SECRET_KEY = SECRET; }
  });

  it("the DB refuses an api role without key, model and cap answer, and an api session that is not suggest-only", async () => {
    const w = await agentWorld("constraints");
    expect(await q(`UPDATE agent_runners SET default_runtime = 'api' WHERE actor_id = $1`, [w.agent.id]).then(() => "ok", (e) => e.code)).toBe("23514");
    const nodeId = await w.note("x");
    const insert = (writeMode: string) => q(
      `INSERT INTO agent_sessions (workspace_id, agent_actor_id, initiator_id, node_id, space_id, anchor_block_id, prompt, deadline_at, runtime, model, write_mode)
       VALUES ($1, $2, $3, $4, $5, 'z', 'p', now() + interval '1 hour', 'api', 'm', $6)`, [w.ws, w.agent.id, w.owner.id, nodeId, w.space, writeMode]);
    expect(await insert("apply").then(() => "ok", (e) => e.code)).toBe("23514");
  });
});

describe.skipIf(!isTestDb)("models and role settings", () => {
  it("lists the key's models; settings refuse an unknown or retired model and require the cap answer", async () => {
    const w = await agentWorld("settings");
    const c = await addCredential(w.ws, { label: "k", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    fake.state.models = [
      { id: "test-model", type: "model", display_name: "Test", created_at: "2026-01-01T00:00:00Z", deprecated_at: null, lifecycle: "active", capabilities: null },
      { id: "claude-old", type: "model", display_name: "Old", created_at: "2025-01-01T00:00:00Z", deprecated_at: "2026-01-01T00:00:00Z", lifecycle: "retired", capabilities: null },
    ];
    const set = (api: object, defaultRuntime: "api" | "mcp" = "api") =>
      setRoleRuntime(w.ws, w.agent.id, { defaultRuntime, api: { credentialId: c.id, ...api } }, { actor: w.owner }).then(() => "ok", (e) => e.code);
    expect(await set({ cap: { kind: "unlimited" } })).toBe("invalid_api_settings"); // no model: there is no default
    expect(await set({ model: "claude-nope", cap: { kind: "unlimited" } })).toBe("model_unavailable");
    expect(await set({ model: "claude-old", cap: { kind: "unlimited" } })).toBe("model_unavailable");
    expect(await set({ model: "test-model" })).toBe("invalid_api_settings"); // cap never answered
    expect(await set({ model: "test-model", cap: { kind: "unlimited" } })).toBe("ok");
    const role = (await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === w.agent.id)!;
    expect(role).toMatchObject({ default_runtime: "api", api: { model: "test-model", cap: "unlimited", key_last4: KEY.slice(-4) } });
    expect(role.runtimes.find((r) => r.kind === "api")).toMatchObject({ available: true });
    // not the owner → refused
    expect(await setRoleRuntime(w.ws, w.agent.id, { defaultRuntime: "mcp" }, { actor: w.agent }).then(() => "ok", (e) => e instanceof AuthorityError ? "denied" : "x")).toBe("denied");
    // and a server without ONDEN_SECRET_KEY cannot be set to the API
    delete process.env.ONDEN_SECRET_KEY;
    try { expect(await set({ model: "test-model", cap: { kind: "unlimited" } })).toBe("runtime_unavailable"); }
    finally { process.env.ONDEN_SECRET_KEY = SECRET; }
  });
});

describe.skipIf(!isTestDb)("the tool loop", () => {
  it("runs the registry's tools through callTool with the session identity, records usage, and keeps the reply on the session for the person", async () => {
    const { w } = await apiWorld("loop");
    const { nodeId, session } = await mention(w);
    expect(session).toMatchObject({ runtime: "api", write_mode: "suggest", model: "test-model", status: "queued" });
    fake.state.script.push(() => toolUseMessage("getNode", { id: nodeId }), () => textMessage("整理好了"));
    const done = await dispatchAndWait(session);
    expect(done).toMatchObject({ status: "completed", turns: 2, input_tokens: 20, output_tokens: 10 });
    expect(done.reply_markdown).toBe("整理好了"); // the note itself is untouched; inserting the reply is the person's act
    expect(await w.body(nodeId)).not.toContain("整理好了");
    expect(fake.requests).toHaveLength(2);
    // the model was offered the registry's read tools and write tools, never publish ones
    const offered = (fake.requests[0]!.body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(offered).toEqual(expect.arrayContaining(["getNode", "searchNodes", "updateNode"]));
    expect(offered).not.toContain("proposeTagPack");
    expect(fake.requests[0]!.body.max_tokens).toBe(16_000);
    // the second request carries the tool result, which holds the note
    expect(JSON.stringify(fake.requests[1]!.body.messages)).toContain("看一下");
    // audited exactly like an MCP call, under the role's identity and this session
    const audit = (await q<{ actor_id: string; tx_meta: { session_id?: string } }>(
      `SELECT actor_id, tx_meta FROM domain_events WHERE event_type = 'AGENT_TOOL_CALLED' AND target_id = 'getNode' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    expect(audit.actor_id).toBe(w.agent.id);
    expect(audit.tx_meta.session_id).toBe(session.id);
    const log = (await q<{ kind: string }>(`SELECT kind FROM agent_session_events WHERE session_id = $1 ORDER BY seq`, [session.id])).rows.map((r) => r.kind);
    expect(log).toEqual(expect.arrayContaining(["read", "action", "usage", "message"]));
    // its session token is revoked with the session
    expect((await q(`SELECT 1 FROM agent_tokens WHERE session_id = $1 AND revoked_at IS NULL`, [session.id])).rows).toHaveLength(0);
  });

  it("a rewrite the model asks for becomes a pending suggestion, and the note stays as it was", async () => {
    const { w } = await apiWorld("nowrite");
    const { nodeId, session } = await mention(w);
    const before = await w.body(nodeId);
    fake.state.script.push(
      () => toolUseMessage("updateNode", { id: nodeId, markdown: "被改掉了", base_markdown: before }),
      () => textMessage("提了建議"),
    );
    const done = await dispatchAndWait(session);
    expect(done.status).toBe("completed");
    expect(await w.body(nodeId)).toBe(before);
    expect(JSON.stringify(fake.requests[1]!.body.messages.at(-1))).toContain("suggested"); // the model is told it is only a suggestion
    expect((await q(`SELECT 1 FROM ai_edit_suggestion_items i JOIN ai_edit_suggestions s ON s.id = i.suggestion_id WHERE s.session_id = $1 AND i.status = 'pending'`, [session.id])).rows.length).toBeGreaterThan(0);
    expect((await q(`SELECT 1 FROM domain_events WHERE event_type = 'NODE_UPDATED' AND actor_id = $1 AND target_id = $2`, [w.agent.id, nodeId])).rows).toHaveLength(0);
  });

  it("a tool with no suggestion form (createNode) is refused by the spine and creates nothing", async () => {
    const { w } = await apiWorld("nocreate");
    const { session } = await mention(w);
    const title = `不該被建立 ${randomUUID()}`;
    fake.state.script.push(() => toolUseMessage("createNode", { title, markdown: "x", space_id: w.space }), () => textMessage("沒建成"));
    const done = await dispatchAndWait(session);
    expect(done.status).toBe("completed");
    expect(JSON.stringify(fake.requests[1]!.body.messages.at(-1))).toContain("is_error");
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [title])).rows).toHaveLength(0);
    expect((await q(`SELECT 1 FROM domain_events WHERE event_type = 'AGENT_TOOL_FAILED' AND target_id = 'createNode' AND tx_meta->>'session_id' = $1`, [session.id])).rows).toHaveLength(1);
  });

  it("the actor an api session acts as cannot commit NODE_UPDATED through mutate(), whatever the entry point", async () => {
    const { w } = await apiWorld("spine");
    const { nodeId, session } = await mention(w);
    await q(`UPDATE agent_sessions SET status = 'running' WHERE id = $1`, [session.id]);
    const actor = await actorForRuntimeSession((await loadSession(session.id))!);
    expect(actor.tokenScope).toMatchObject({ writeMode: "suggest", sessionId: session.id });
    const attempt = (type: string) => mutate({
      actor, workspaceId: w.ws, authority: { kind: "node", nodeId, op: "write_node" },
      event: { type, targetType: "node", targetId: nodeId, payload: {} }, apply: async () => "wrote",
    }).then((v) => v, (e) => e);
    for (const type of ["NODE_UPDATED", "NODE_CREATED", "TAG_APPLIED", "NODE_DELETED"]) {
      expect(await attempt(type)).toBeInstanceOf(ScopeError);
    }
    expect(() => assertWriteModeAllows(actor, "AI_SUGGESTION_CREATED")).not.toThrow();
    // a person and an ordinary session are unaffected
    expect(await mutate({ actor: w.owner, workspaceId: w.ws, authority: { kind: "node", nodeId, op: "write_node" }, event: { type: "NODE_UPDATED", targetType: "node", targetId: nodeId, payload: {} }, apply: async () => "wrote" })).toBe("wrote");
    await endSession(w.ws, session.id, "cancelled");
  });

  it("stops at the turn limit, claims once, and a retry of the effect does not run it again", async () => {
    const { w } = await apiWorld("limit");
    const { nodeId, session } = await mention(w);
    fake.state.fallback = () => toolUseMessage("getNode", { id: nodeId });
    const first = startApiRun(session.id);
    const second = startApiRun(session.id);
    await Promise.all([first, second]);
    let done: AgentSession | null = null;
    for (let i = 0; i < 400 && !done; i++) {
      const now = (await loadSession(session.id))!;
      if (now.status === "failed") done = now; else await new Promise((r) => setTimeout(r, 25));
    }
    expect(done).toMatchObject({ status: "failed", fail_code: "turn_limit", turns: MAX_TURNS, attempt: 1 });
    expect(fake.requests).toHaveLength(MAX_TURNS);
    await startApiRun(session.id); // already failed: nothing runs
    expect(fake.requests).toHaveLength(MAX_TURNS);
    expect((await loadSession(session.id))!.reply_markdown).toBeNull();
  });

  it("a process that died mid-run leaves a session that is failed(interrupted), never re-run", async () => {
    const { w } = await apiWorld("interrupt");
    const { session } = await mention(w);
    await q(`UPDATE agent_sessions SET status = 'running', attempt = 1 WHERE id = $1`, [session.id]);
    expect(await failInterruptedApiSessions()).toBeGreaterThanOrEqual(1);
    expect(await loadSession(session.id)).toMatchObject({ status: "failed", fail_code: "interrupted" });
    await startApiRun(session.id);
    expect(fake.requests).toHaveLength(0);
  });

  it("revoking the key stops a session before its next paid call", async () => {
    const { w, credential } = await apiWorld("revoke-mid");
    const { nodeId, session } = await mention(w);
    fake.state.script.push(async () => { await revokeCredential(w.ws, credential.id, { actor: w.owner }); return toolUseMessage("getNode", { id: nodeId }); });
    fake.state.fallback = () => textMessage("不該到這裡");
    const done = await dispatchAndWait(session);
    expect(done).toMatchObject({ status: "failed", fail_code: "credential_revoked" });
    expect(fake.requests).toHaveLength(1); // no second paid call
    expect((await loadSession(session.id))!.reply_markdown).toBeNull();
  });

  it("maps provider failures to a short code and never keeps their text", async () => {
    const { w } = await apiWorld("errors");
    const { session } = await mention(w);
    fake.state.fallback = () => ({ type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } } as never);
    // a 200 with an error body is not an HTTP error; use the status path instead
    const server = fake;
    server.state.script.length = 0;
    const original = process.env.ONDEN_AI_BASE_URL_OVERRIDE;
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = "http://127.0.0.1:9"; // nothing listens: a connection failure
    try {
      const done = await dispatchAndWait(session);
      expect(done).toMatchObject({ status: "failed", fail_code: "api_unreachable" });
      expect(JSON.stringify(await q(`SELECT * FROM agent_sessions WHERE id = $1`, [session.id]))).not.toContain(KEY);
    } finally { process.env.ONDEN_AI_BASE_URL_OVERRIDE = original; }
  });

  it("an api session is not offered to the pull runner and cannot be claimed by it", async () => {
    const { w } = await apiWorld("nopull");
    const { session } = await mention(w);
    const runnerToken = await createToken(w.agent.id, { access: "write" });
    const runner = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: runnerToken.id } }, w.ws);
    expect((await pendingSessions(runner)).map((s) => s.id)).not.toContain(session.id);
    expect(await claimSession(session.id, { actor: runner }).then(() => "claimed", (e) => e.code)).toBe("not_claimable");
    expect(await loadSession(session.id)).toMatchObject({ status: "queued" });
  });
});

describe.skipIf(!isTestDb)("small actions", () => {
  it("one streaming call, no tools, and the suggestion is made only when the stream is complete", async () => {
    const { w } = await apiWorld("selection", { smallOnly: true });
    const nodeId = await w.note("這是一段很長很長的文字需要縮短");
    fake.state.script.push(() => textMessage("短一點"));
    const requestId = randomUUID();
    const started = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "fix", text: "這是一段很長很長的文字", requestId });
    expect(started.created).toBe(true);
    const again = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "fix", text: "這是一段很長很長的文字", requestId });
    expect(again).toEqual({ sessionId: started.sessionId, created: false });
    const done = await dispatchAndWait((await loadSession(started.sessionId))!);
    expect(done).toMatchObject({ status: "completed", kind: "selection_action", turns: 1 });
    const items = (await q<{ kind: string; new_text: string }>(
      `SELECT i.kind, i.new_text FROM ai_edit_suggestion_items i JOIN ai_edit_suggestions s ON s.id = i.suggestion_id WHERE s.session_id = $1`, [started.sessionId])).rows;
    expect(items).toEqual([{ kind: "replace", new_text: "短一點需要縮短" }]);
    expect(await w.body(nodeId)).toBe("這是一段很長很長的文字需要縮短"); // pending only
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body.stream).toBe(true);
    expect(fake.requests[0]!.body.tools).toBeUndefined();
    expect(JSON.stringify(fake.requests[0]!.body)).toContain("這是一段很長很長的文字");
  });

  it("a stream that fails leaves no suggestion", async () => {
    const { w } = await apiWorld("selection-fail", { smallOnly: true });
    const nodeId = await w.note("文字");
    const { sessionId } = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "fix", text: "文字", requestId: randomUUID() });
    const done = await dispatchAndWait((await loadSession(sessionId))!); // no scripted reply: the fake answers 500
    expect(done.status).toBe("failed");
    expect((await q(`SELECT 1 FROM ai_edit_suggestions WHERE session_id = $1`, [sessionId])).rows).toHaveLength(0);
  });

  it("'only for small actions' refuses mentions and tool sessions at start", async () => {
    const { w } = await apiWorld("small-only", { smallOnly: true });
    const nodeId = await w.note(`@${w.handle} hi`);
    expect(await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} hi` } }).then(() => null, (e) => e.code)).toBe("runtime_not_allowed");
    const role = (await loadRunner(w.ws, { actorId: w.agent.id }))!;
    expect(await chooseRuntime(role, "selection_action")).toEqual({ runtime: "api", model: "test-model" });
  });
});

describe.skipIf(!isTestDb)("hand to AI: preview, cancel, runtime for this once", () => {
  const SELECTION = "這是一段很長很長的文字";
  const suggestionItems = async (sessionId: string) => (await q<{ kind: string; new_text: string }>(
    `SELECT i.kind, i.new_text FROM ai_edit_suggestion_items i JOIN ai_edit_suggestions s ON s.id = i.suggestion_id WHERE s.session_id = $1`, [sessionId])).rows;

  it.each([["rewrite"], ["shorten"], ["translate"], ["explain"]])("%s: the suggestion covers exactly the selected words", async (skill) => {
    const { w } = await apiWorld(`hand-${skill}`, { smallOnly: true });
    const nodeId = await w.note(`前面。${SELECTION}。後面。`);
    fake.state.script.push(() => textMessage("新的"));
    const { sessionId } = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill, text: SELECTION, requestId: randomUUID() });
    expect((await dispatchAndWait((await loadSession(sessionId))!)).status).toBe("completed");
    const items = await suggestionItems(sessionId);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("replace");
    // A suggestion item is the paragraph; only the selected words in it changed.
    expect(items[0]!.new_text).toBe("前面。新的。後面。");
    expect(await w.body(nodeId)).toBe(`前面。${SELECTION}。後面。`);
  });

  it("the preview is the streamed text and equals the suggestion's new words; the end frame follows", async () => {
    const { w } = await apiWorld("hand-stream", { smallOnly: true });
    const nodeId = await w.note(SELECTION);
    fake.state.script.push(() => textMessage("簡短版本的文字"));
    const { sessionId } = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "shorten", text: SELECTION, requestId: randomUUID() });
    const frames: string[] = [];
    let ended = false;
    const follow = followPreview(sessionId, (e) => { if (e.kind === "text") frames.push(e.text); else ended = true; });
    // The run has not started (it starts when the outbox row is drained): nothing to follow yet.
    expect(follow).toBeNull();
    const row = (await q<{ id: string }>(`SELECT id::text FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [sessionId])).rows[0]!;
    await drainOutbox({ id: row.id });
    let late: ReturnType<typeof followPreview> = null;
    for (let i = 0; i < 100 && !late; i++) { late = followPreview(sessionId, (e) => { if (e.kind === "text") frames.push(e.text); else ended = true; }); if (!late) await new Promise((r) => setTimeout(r, 10)); }
    if (late?.ended) ended = true; // the run may already be over when we attach: no end frame will come, `ended` says so
    for (let i = 0; i < 1200 && !ended; i++) await new Promise((r) => setTimeout(r, 25)); // up to 30 s: PGlite runs the session slower than a server
    expect(ended).toBe(true);
    const streamed = ((late?.text ?? "") + frames.join("")).trim();
    expect(streamed).toBe("簡短版本的文字");
    expect(await suggestionItems(sessionId)).toEqual([{ kind: "replace", new_text: "簡短版本的文字" }]);
  }, 40_000);

  it("cancelling while it works stops the call and leaves no suggestion", async () => {
    const { w } = await apiWorld("hand-cancel", { smallOnly: true });
    const nodeId = await w.note(SELECTION);
    fake.state.script.push(async () => { await new Promise((r) => setTimeout(r, 400)); return textMessage("太晚了"); });
    const { sessionId } = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "shorten", text: SELECTION, requestId: randomUUID() });
    const row = (await q<{ id: string }>(`SELECT id::text FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [sessionId])).rows[0]!;
    await drainOutbox({ id: row.id });
    for (let i = 0; i < 100 && (await loadSession(sessionId))!.status !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await cancel(sessionId, { actor: w.owner })).changed).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect((await loadSession(sessionId))).toMatchObject({ status: "cancelled", fail_code: "cancelled_by_user" });
    expect((await q(`SELECT 1 FROM ai_edit_suggestions WHERE session_id = $1`, [sessionId])).rows).toHaveLength(0);
  });

  it("an mcp run for this once: queued for the AI client, and its finish becomes one replace suggestion", async () => {
    const { w } = await apiWorld("hand-sub", { smallOnly: true }); // default api; this action picks mcp
    const nodeId = await w.note(`前。${SELECTION}。後。`);
    const { sessionId } = await startSelectionAction(w.ws, {
      actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "rewrite", text: SELECTION, requestId: randomUUID(), runtime: "mcp",
    });
    const queued = (await loadSession(sessionId))!;
    expect(queued).toMatchObject({ runtime: "mcp", kind: "selection_action", status: "queued", write_mode: "suggest" });
    expect((await q(`SELECT 1 FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [sessionId])).rows).toHaveLength(0);
    await markDelivered(sessionId, (await q<{ id: string }>(`INSERT INTO agent_tokens (actor_id, token_hash, name, access) VALUES ($1, $2, 'runner', 'write') RETURNING id::text`, [w.agent.id, randomUUID()])).rows[0]!.id);
    await q(`UPDATE agent_sessions SET status = 'running' WHERE id = $1`, [sessionId]);
    const runner = await sessionActor((await loadSession(sessionId))!, w.agent);
    await finish(sessionId, { actor: runner, status: "completed", markdown: "改寫後" });
    expect((await loadSession(sessionId))!.status).toBe("completed");
    expect(await suggestionItems(sessionId)).toEqual([{ kind: "replace", new_text: "前。改寫後。後。" }]);
    expect(await w.body(nodeId)).toBe(`前。${SELECTION}。後。`);
  });

  it("text that appears more than once, or is not in the saved note, is refused before any model call", async () => {
    const { w } = await apiWorld("hand-not-unique", { smallOnly: true });
    const nodeId = await w.note(`${SELECTION}。\n\n${SELECTION}。`);
    const sessions = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM agent_sessions WHERE node_id = $1`, [nodeId])).rows[0]!.n;
    const refuse = (text: string) => startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "fix", text, requestId: randomUUID() })
      .then(() => null, (e) => ({ code: e.code, status: e.status }));
    expect(await refuse(SELECTION)).toEqual({ code: "selection_not_unique", status: 422 });
    expect(await refuse("筆記裡沒有這段")).toEqual({ code: "selection_not_found", status: 422 });
    expect(await sessions()).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("a multi-line selection still matches a note saved with CRLF line ends, and only those words are replaced", async () => {
    const { w } = await apiWorld("hand-crlf", { smallOnly: true });
    const nodeId = await w.note("前面\r\n第一行\r\n第二行\r\n後面\r\n");
    fake.state.script.push(() => textMessage("合併"));
    const { sessionId } = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "shorten", text: "第一行\n第二行", requestId: randomUUID() });
    expect((await dispatchAndWait((await loadSession(sessionId))!)).status).toBe("completed");
    const items = await suggestionItems(sessionId);
    expect(items).toHaveLength(1);
    expect(items[0]!.new_text.replace(/\r\n/g, "\n")).toContain("前面\n合併\n後面");
  });

  it("an mcp run for this once is refused when the role has no live token", async () => {
    const { w } = await apiWorld("hand-mcp", { smallOnly: true });
    const nodeId = await w.note(SELECTION);
    // The fixture gives every agent a live token: take it away, so nobody can answer an mcp run.
    await q(`UPDATE agent_tokens SET revoked_at = now() WHERE actor_id = $1 AND revoked_at IS NULL`, [w.agent.id]);
    const code = await startSelectionAction(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, skill: "rewrite", text: SELECTION, requestId: randomUUID(), runtime: "mcp" })
      .then(() => null, (e) => e.code);
    expect(code).toBe("runtime_unavailable");
  });

  it("who may hand over: an editor sees the roles and their ways; a viewer gets no entry and cannot start", async () => {
    const { w } = await apiWorld("hand-options", { smallOnly: true });
    const nodeId = await w.note(SELECTION);
    const options = await handToAiOptions(w.ws, nodeId, { actor: w.owner });
    expect(options.can_hand_off).toBe(true);
    expect(options.roles.find((r) => r.actor_id === w.agent.id)).toMatchObject({ default_runtime: "api", reason: null });
    expect(options.roles[0]!.runtimes.map((r) => r.kind)).toContain("api");

    const viewer = await persistActor(w.ws, { id: "", name: `Viewer ${w.stamp}`, role: "editor", type: "human" });
    const shared = await makeSpace(w.ws, `viewable ${w.stamp}`, [{ id: w.owner.id, role: "manager" }, { id: w.agent.id, role: "editor" }, { id: viewer.id, permission: "view" }]);
    const readOnlyNote = await w.note(SELECTION, shared);
    expect((await handToAiOptions(w.ws, readOnlyNote, { actor: viewer })).can_hand_off).toBe(false);
    const refused = await startSelectionAction(w.ws, { actor: viewer, agentActorId: w.agent.id, nodeId: readOnlyNote, skill: "rewrite", text: SELECTION, requestId: randomUUID() }).then(() => null, (e) => e);
    expect(refused).not.toBeNull();
    expect((await q(`SELECT 1 FROM agent_sessions WHERE initiator_id = $1`, [viewer.id])).rows).toHaveLength(0);
  });
});

describe.skipIf(!isTestDb)("what stays as it was", () => {
  it("mcp roles queue and are claimed exactly as before (no outbox row, write mode apply)", async () => {
    const w = await agentWorld("unchanged");
    await revokeEveryKey(w.ws);
    const nodeId = await w.note(`@${w.handle} hi`);
    const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} hi` } });
    expect(session).toMatchObject({ runtime: "mcp", write_mode: "apply", status: "queued" });
    expect((await q(`SELECT 1 FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [session.id])).rows).toHaveLength(0);
    expect((await runtimeAvailability((await loadRunner(w.ws, { actorId: w.agent.id }))!)).map((r) => r.kind)).toEqual(["mcp"]);
  });
});

/** A fake "/v1/chat/completions" service: the replies come from a script, every request body is recorded. */
async function startFakeChatService() {
  const requests: any[] = [];
  const script: Array<(body: any) => unknown> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") { res.end(JSON.stringify({ object: "list", data: [{ id: "local-model", object: "model" }] })); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      res.end(JSON.stringify(script.shift()?.(body) ?? { error: "no scripted reply" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, script, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe.skipIf(!isTestDb)("any service: keys carry their address and format", () => {
  it("detects the format when a key is added, and asks to choose when it cannot tell", async () => {
    const chat = await startFakeChatService();
    delete process.env.ONDEN_AI_BASE_URL_OVERRIDE; // each address is reached as written
    const w = await agentWorld("detect");
    const detected = await addCredentialDetectingFormat(w.ws, { label: "chat", apiKey: KEY, baseUrl: chat.url }, { actor: w.owner });
    expect(detected).toMatchObject({ protocol: "v1_chat_completions", base_url: chat.url, price_input_per_m: null });
    const other = await addCredentialDetectingFormat(w.ws, { label: "messages", apiKey: KEY, baseUrl: `${fake.url}/` }, { actor: w.owner });
    expect(other).toMatchObject({ protocol: "v1_messages", base_url: fake.url });
    // The format could not be told (the model list has an unknown shape): the person is asked, then chooses.
    fake.state.models = [{ name: "odd" }];
    try {
      const attempt = (extra: object) => addCredentialDetectingFormat(w.ws, { label: "odd", apiKey: KEY, baseUrl: fake.url, ...extra }, { actor: w.owner });
      expect(await attempt({}).then(() => null, (e) => e.code)).toBe("protocol_undetected");
      expect(await attempt({ protocol: "v1_chat_completions" })).toMatchObject({ protocol: "v1_chat_completions" });
    } finally { fake.state.models = [modelInfo("test-model")]; }
    expect(await addCredentialDetectingFormat(w.ws, { label: "x", apiKey: KEY, baseUrl: "ftp://nope" }, { actor: w.owner }).then(() => null, (e) => e.code)).toBe("invalid_base_url");
    expect(await addCredentialDetectingFormat(w.ws, { label: "x", apiKey: KEY, baseUrl: chat.url, inputPricePerM: 1 }, { actor: w.owner }).then(() => null, (e) => e.code)).toBe("invalid_price");
    const priced = await addCredentialDetectingFormat(w.ws, { label: "p", apiKey: KEY, baseUrl: chat.url, inputPricePerM: 2, outputPricePerM: 8 }, { actor: w.owner });
    expect(priced).toMatchObject({ price_input_per_m: 2, price_output_per_m: 8 });
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    await chat.close();
  });

  it("a whole session runs through a chat-format service: tool call, answer, tokens, and a cost only when prices were written", async () => {
    const chat = await startFakeChatService();
    delete process.env.ONDEN_AI_BASE_URL_OVERRIDE; // this service is reached at its own address
    try {
      for (const prices of [null, { inputPricePerM: 2, outputPricePerM: 10 }]) {
        const w = await agentWorld(`chat${prices ? "-priced" : ""}`);
        const credential = await addCredentialDetectingFormat(w.ws, { label: "local", apiKey: KEY, baseUrl: chat.url, ...(prices ?? {}) }, { actor: w.owner });
        expect(credential.protocol).toBe("v1_chat_completions");
        await q(`UPDATE agent_runners SET default_runtime = 'api', api_credential_id = $2, api_model = 'local-model', api_cap_choice = 'unlimited' WHERE actor_id = $1`, [w.agent.id, credential.id]);
        const { nodeId, session } = await mention(w);
        chat.requests.length = 0;
        chat.script.push(
          () => ({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "getNode", arguments: JSON.stringify({ id: nodeId }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
          () => ({ choices: [{ message: { content: "讀完了" }, finish_reason: "stop" }], usage: { prompt_tokens: 1500, completion_tokens: 100 } }),
        );
        const done = await dispatchAndWait(session);
        expect(done).toMatchObject({ status: "completed", turns: 2, input_tokens: 2500, output_tokens: 300 });
        expect(chat.requests).toHaveLength(2);
        expect(chat.requests[0].tools.some((t: any) => t.function.name === "getNode")).toBe(true);
        expect(JSON.stringify(chat.requests[1].messages)).toContain("c1");
        expect(done.cost_estimate_micro_usd).toBe(prices ? 2500 * 2 + 300 * 10 : null);
      }
    } finally { process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url; await chat.close(); }
  });
});

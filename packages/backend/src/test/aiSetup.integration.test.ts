// 設定 › AI: making an AI with its connection in one step (services/aiSetup.ts), testing a key before it is
// kept, and who may. The rule that matters most: a space that does not let AI read stays closed and the new AI
// is not in it, whatever the flow (first use, a new connection, a new AI, a changed connection).
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database. No test reaches a real service.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { pool, q } from "../db.js";
import { addCredential, revokeCredential } from "../services/aiCredentials.js";
import { testCredential, testStoredCredential } from "../services/aiCredentialSetup.js";
import { setUpAi } from "../services/aiSetup.js";
import { roleRuntimes, setRoleRuntime } from "../services/aiRoles.js";
import { AuthorityError } from "../spine/authority.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import { startFakeMessagesService } from "./helpers/fakeMessagesService.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import aiRuntimeRouter from "../routes/aiRuntime.js";
import { aiModule } from "../modules/ai/index.js";
import { moduleWriteGate } from "../modules/index.js";
import type { ActorCtx } from "../types.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const KEY = "sk-test-abcdefghijklmnopqrstuvwxyz0123456789WXYZ";
let fake: Awaited<ReturnType<typeof startFakeMessagesService>>;
let refusing: Server;
let refusingUrl = "";

beforeAll(async () => {
  if (!isTestDb) return;
  process.env.ONDEN_SECRET_KEY = "ab".repeat(32);
  fake = await startFakeMessagesService();
  // A service that refuses every key.
  refusing = createServer((_req, res) => { res.statusCode = 401; res.end("{}"); });
  await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
  refusingUrl = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (isTestDb) { await fake.close(); await new Promise((resolve) => refusing.close(resolve)); }
  delete process.env.ONDEN_SECRET_KEY;
  delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
  await pool.end();
});

const count = async (sql: string, args: unknown[] = []) => (await q<{ n: number }>(sql, args)).rows[0]!.n;
const agentCount = (ws: string) => count(`SELECT count(*)::int AS n FROM actors WHERE workspace_id = $1 AND type = 'agent'`, [ws]);
const keyCount = (ws: string) => count(`SELECT count(*)::int AS n FROM ai_credentials WHERE workspace_id = $1`, [ws]);
const switchOf = async (spaceId: string) =>
  (await q<{ on: string | null }>(`SELECT capabilities->>'external_ai' AS on FROM spaces WHERE id = $1`, [spaceId])).rows[0]!.on;
const standing = async (spaceId: string, actorId: string) =>
  (await q<{ permission: string }>(`SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [spaceId, actorId])).rows[0]?.permission ?? null;
const newKey = (label = "my key") => ({
  kind: "api_new" as const, label, api_key: KEY, base_url: "http://x.invalid", protocol: "v1_messages",
  model: "test-model", cap: { kind: "unlimited" as const },
});

describe.skipIf(!isTestDb)("設定 › AI: setting up an AI", () => {
  it("first connection: one AI named AI, suggest-only, standing only where AI reading is already on", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("setup-first");
    const open = await makeSpace(w.ws, `open ${w.stamp}`, [{ id: w.owner.id, role: "manager" }], { publish: false, external_ai: true, backup: true });
    const closed = await makeSpace(w.ws, `closed ${w.stamp}`, [{ id: w.owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    const agentsBefore = await agentCount(w.ws);
    const keysBefore = await keyCount(w.ws);

    const made = await setUpAi(w.ws, { name: "AI", connection: newKey() }, { actor: w.owner });

    expect(await agentCount(w.ws)).toBe(agentsBefore + 1);
    expect(await keyCount(w.ws)).toBe(keysBefore + 1);
    expect(made.handle).toMatch(/^ai\d*$/);
    expect(made.credential_id).not.toBeNull();
    expect(made.token).toBeNull();
    const writeMode = (await q<{ write_mode: string }>(`SELECT write_mode FROM actors WHERE id = $1`, [made.actor_id])).rows[0]!.write_mode;
    expect(writeMode).toBe("suggest");
    expect(await standing(open, made.actor_id)).toBe("edit"); // it can run at once; suggest-only keeps every change waiting for the owner
    expect(await standing(closed, made.actor_id)).toBeNull();
    expect(await switchOf(closed)).toBe("false"); // never opened by this flow
    expect(made.joined_space_ids).toContain(open);
    expect(made.joined_space_ids).not.toContain(closed);

    const role = (await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === made.actor_id)!;
    expect(role.enabled).toBe(true);
    expect(role.default_runtime).toBe("api");
    expect(role.api?.credential_id).toBe(made.credential_id);
    expect(role.api?.model).toBe("test-model");
  });

  it("a second AI on the same key gets the next free @name and the closed space stays closed", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("setup-second");
    const closed = await makeSpace(w.ws, `closed ${w.stamp}`, [{ id: w.owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    const first = await setUpAi(w.ws, { name: "AI", connection: newKey() }, { actor: w.owner });
    const second = await setUpAi(w.ws, {
      name: "Reader", connection: { kind: "api", credential_id: first.credential_id!, model: "test-model", cap: { kind: "capped", tokens: 5000 } },
    }, { actor: w.owner });
    expect(second.handle).not.toBe(first.handle);
    expect(second.credential_id).toBeNull(); // it uses a key that was already there
    expect(await standing(closed, second.actor_id)).toBeNull();
    expect(await switchOf(closed)).toBe("false");
    const role = (await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === second.actor_id)!;
    expect(role.api?.monthly_cap_tokens).toBe(5000);
  });

  it("changing an AI's connection does not touch any space's AI-reading switch", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("setup-swap");
    const closed = await makeSpace(w.ws, `closed ${w.stamp}`, [{ id: w.owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    const first = await setUpAi(w.ws, { name: "AI", connection: newKey("one") }, { actor: w.owner });
    const other = await addCredential(w.ws, { label: "two", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    await setRoleRuntime(w.ws, first.actor_id, { api: { credentialId: other.id, model: "test-model" } }, { actor: w.owner });
    expect(await switchOf(closed)).toBe("false");
    expect(await standing(closed, first.actor_id)).toBeNull();
  });

  it("a key the service refuses leaves nothing behind: no AI, no key", async () => {
    const w = await agentWorld("setup-refused");
    const agentsBefore = await agentCount(w.ws);
    const keysBefore = await keyCount(w.ws);
    delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
    await expect(setUpAi(w.ws, { name: "AI", connection: { ...newKey(), protocol: undefined, base_url: refusingUrl } }, { actor: w.owner }))
      .rejects.toMatchObject({ code: "credential_rejected" });
    expect(await agentCount(w.ws)).toBe(agentsBefore);
    expect(await keyCount(w.ws)).toBe(keysBefore);
  });

  it("a model the key does not list rolls the whole step back (the key too)", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("setup-nomodel");
    const agentsBefore = await agentCount(w.ws);
    const keysBefore = await keyCount(w.ws);
    await expect(setUpAi(w.ws, { name: "AI", connection: { ...newKey(), model: "not-listed" } }, { actor: w.owner }))
      .rejects.toMatchObject({ code: "model_unavailable" });
    expect(await agentCount(w.ws)).toBe(agentsBefore);
    expect(await keyCount(w.ws)).toBe(keysBefore);
    expect(await count(`SELECT count(*)::int AS n FROM agent_runners WHERE workspace_id = $1 AND actor_id NOT IN (SELECT id FROM actors)`, [w.ws])).toBe(0);
  });

  it("a connection code: the AI gets a code (shown once) and no key is kept", async () => {
    const w = await agentWorld("setup-mcp");
    const keysBefore = await keyCount(w.ws);
    const made = await setUpAi(w.ws, { name: "AI", connection: { kind: "mcp" } }, { actor: w.owner });
    expect(made.token).toMatch(/\S{16,}/);
    expect(made.credential_id).toBeNull();
    expect(await keyCount(w.ws)).toBe(keysBefore);
    const live = await count(`SELECT count(*)::int AS n FROM agent_tokens WHERE actor_id = $1 AND revoked_at IS NULL`, [made.actor_id]);
    expect(live).toBe(1);
  });

  it("only the owner: a member is refused for every entry, and nothing is made", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("setup-member");
    const member = await persistActor(w.ws, { id: "", name: `Member ${w.stamp}`, role: "editor", type: "human" });
    const agentsBefore = await agentCount(w.ws);
    await expect(setUpAi(w.ws, { name: "AI", connection: newKey() }, { actor: member })).rejects.toBeInstanceOf(AuthorityError);
    await expect(testCredential({ apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: member })).rejects.toBeInstanceOf(AuthorityError);
    await expect(roleRuntimes(w.ws, { actor: member })).rejects.toBeInstanceOf(AuthorityError);
    expect(await agentCount(w.ws)).toBe(agentsBefore);
  });
});

describe.skipIf(!isTestDb)("設定 › AI: testing a key and losing one", () => {
  it("test lists the models and saves nothing; a refused key and a dead address are told apart", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("test-key");
    const keysBefore = await keyCount(w.ws);
    const ok = await testCredential({ apiKey: KEY, baseUrl: "http://x.invalid" }, { actor: w.owner });
    expect(ok.protocol).toBe("v1_messages");
    expect(ok.models.map((m) => m.id)).toEqual(["test-model"]);
    expect(await keyCount(w.ws)).toBe(keysBefore);
    delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
    await expect(testCredential({ apiKey: KEY, baseUrl: refusingUrl }, { actor: w.owner })).rejects.toMatchObject({ code: "credential_rejected" });
    const kept = await addCredential(w.ws, { label: "kept", apiKey: KEY, baseUrl: "http://x.invalid", protocol: "v1_messages" }, { actor: w.owner });
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    expect(await testStoredCredential(w.ws, kept.id, { actor: w.owner })).toMatchObject({ protocol: "v1_messages" });
    delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
    const refused = await addCredential(w.ws, { label: "refused", apiKey: KEY, baseUrl: refusingUrl, protocol: "v1_messages" }, { actor: w.owner });
    await expect(testStoredCredential(w.ws, refused.id, { actor: w.owner })).rejects.toMatchObject({ code: "credential_rejected" });
    await expect(testCredential({ apiKey: KEY, baseUrl: "http://127.0.0.1:1" }, { actor: w.owner })).rejects.toMatchObject({ code: "service_unreachable" });
  });

  it("revoking the key an AI uses shows it without a connection; choosing another restores it", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("lose-key");
    const open = await makeSpace(w.ws, `open ${w.stamp}`, [{ id: w.owner.id, role: "manager" }]);
    const made = await setUpAi(w.ws, { name: "AI", connection: newKey("one") }, { actor: w.owner });
    await revokeCredential(w.ws, made.credential_id!, { actor: w.owner });
    const lost = (await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === made.actor_id)!;
    // Still an AI that runs through the API, with no live key: `api` is null once the workspace has no live key at all.
    expect(lost.default_runtime).toBe("api");
    expect(lost.api?.credential_id ?? null).toBeNull();
    expect(lost.runtimes.find((r) => r.kind === "api")?.available ?? false).toBe(false);
    const other = await addCredential(w.ws, { label: "two", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    await setRoleRuntime(w.ws, made.actor_id, { api: { credentialId: other.id, model: "test-model" } }, { actor: w.owner });
    // Born "edit" where AI may read (the API needs it in one such space), so the new key is all it took.
    const back = (await roleRuntimes(w.ws, { actor: w.owner })).find((r) => r.actor_id === made.actor_id)!;
    expect(back.api?.credential_id).toBe(other.id);
    expect(back.runtimes.find((r) => r.kind === "api")).toMatchObject({ available: true, unavailable_reason: null });
  });
});

describe.skipIf(!isTestDb)("設定 › AI over HTTP: not for anyone but the owner", () => {
  it("a token of an AI (not the owner) is refused by every entry the page uses, and nothing is made", async () => {
    const w = await agentWorld("setup-http");
    const { createToken } = await import("../services/agentTokens.js");
    const token = await createToken(w.agent.id, { access: "write", issuedBy: w.owner.id });
    const { app } = await import("../app.js");
    const call = (path: string, method: string, json?: unknown) => app.request(path, {
      method, headers: { origin: "http://localhost", authorization: `Bearer ${token.plaintext}`, ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    const agentsBefore = await agentCount(w.ws);
    const keysBefore = await keyCount(w.ws);
    const refused = [
      await call("/api/ai/credentials", "GET"),
      await call("/api/ai/roles", "GET"),
      await call("/api/ai/credentials/test", "POST", { base_url: "http://x.invalid", api_key: KEY }),
      await call(`/api/ai/credentials/${w.agent.id}/test`, "POST"),
      await call("/api/ai/roles", "POST", { name: "AI", connection: { kind: "mcp" } }),
    ];
    for (const res of refused) expect([401, 403]).toContain(res.status);
    expect(await agentCount(w.ws)).toBe(agentsBefore);
    expect(await keyCount(w.ws)).toBe(keysBefore);
  });
});

/** The real routes of /api/ai, with the module gate in front as in production, called as `actor`. */
function aiApp(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.use("/api/ai/*", moduleWriteGate(aiModule));
  hono.route("/api/ai", aiRuntimeRouter);
  return hono;
}
const send = (app: Hono<{ Variables: { actor: ActorCtx } }>, method: string, path: string, json?: unknown) =>
  app.request(path, { method, headers: json ? { "content-type": "application/json" } : {}, body: json ? JSON.stringify(json) : undefined });

describe.skipIf(!isTestDb)("設定 › AI through the real routes", () => {
  it("a human member (not the owner) is refused by every entry the page uses, and nothing is made", async () => {
    const w = await agentWorld("route-member");
    await setModulesOn(w.ws, ["ai"]);
    const member = await persistActor(w.ws, { id: "", name: `Member ${w.stamp}`, role: "editor", type: "human" });
    const app = aiApp(member);
    const agentsBefore = await agentCount(w.ws);
    const keysBefore = await keyCount(w.ws);
    const calls = [
      ["GET", "/api/ai/credentials"], ["GET", "/api/ai/roles"],
      ["POST", "/api/ai/credentials/test", { base_url: "http://x.invalid", api_key: KEY }],
      ["POST", `/api/ai/credentials/${w.agent.id}/test`, {}],
      ["POST", "/api/ai/roles", { name: "AI", connection: { kind: "mcp" } }],
      ["POST", "/api/ai/credentials", { label: "k", api_key: KEY, base_url: "http://x.invalid", protocol: "v1_messages" }],
    ] as const;
    for (const [method, path, json] of calls) expect((await send(app, method, path, json)).status, `${method} ${path}`).toBe(403);
    expect(await agentCount(w.ws)).toBe(agentsBefore);
    expect(await keyCount(w.ws)).toBe(keysBefore);
  });

  it("module off: testing a key works (it writes nothing); making an AI is refused and makes nothing", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("route-gate");
    await setModulesOn(w.ws, []);
    const app = aiApp(w.owner);
    const agentsBefore = await agentCount(w.ws);
    const tested = await send(app, "POST", "/api/ai/credentials/test", { base_url: "http://x.invalid", api_key: KEY });
    expect(tested.status).toBe(200);
    const refused = await send(app, "POST", "/api/ai/roles", { name: "AI", connection: { kind: "mcp" } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "module_not_imported" });
    expect(await agentCount(w.ws)).toBe(agentsBefore);
    await setModulesOn(w.ws, ["ai"]);
  });

  it("a new AI, then another connection for it, through the routes: a space that does not let AI read stays closed and the AI is not in it", async () => {
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
    const w = await agentWorld("route-closed");
    await setModulesOn(w.ws, ["ai"]);
    const closed = await makeSpace(w.ws, `closed ${w.stamp}`, [{ id: w.owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    const app = aiApp(w.owner);
    const made = await (await send(app, "POST", "/api/ai/roles", { name: "AI", connection: newKey("first") })).json() as { actor_id: string; credential_id: string };
    const second = await (await send(app, "POST", "/api/ai/credentials", { label: "second", api_key: KEY, base_url: "http://x.invalid", protocol: "v1_messages" })).json() as { credential: { id: string } };
    const swapped = await send(app, "PUT", `/api/ai/roles/${made.actor_id}/runtime`, { default_runtime: "api", api: { credential_id: second.credential.id, model: "test-model", cap: { kind: "unlimited" } } });
    expect(swapped.status).toBe(200);
    const another = await send(app, "POST", "/api/ai/roles", { name: "Reader", connection: { kind: "api", credential_id: second.credential.id, model: "test-model", cap: { kind: "unlimited" } } });
    expect(another.status).toBe(201);
    const readerId = ((await another.json()) as { actor_id: string }).actor_id;
    expect(await switchOf(closed)).toBe("false");
    expect(await standing(closed, made.actor_id)).toBeNull();
    expect(await standing(closed, readerId)).toBeNull();
  });
});

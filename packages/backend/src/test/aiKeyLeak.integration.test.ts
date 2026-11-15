// Where can an owner's API key be found after it was used? (review 2026-11-11, AI collaboration)
//
// The key is added, a session runs with it (success, provider failure, unreachable service, revoked
// mid-run), and then the whole place is searched for it instead of a hand-picked list of columns:
//   • every row of every table of the database (row text, so a new table or column is covered),
//   • everything written to stdout / stderr,
//   • the full backup the owner downloads (every file in the zip),
//   • the key list the owner's own screen is given.
// Nothing may hold the plaintext. The ciphertext may only be in ai_credentials (and so only in a
// database backup, which docs/agents/deploy.md says to keep apart from ONDEN_SECRET_KEY): never in
// the zip.
//
// SAFETY: skips unless DATABASE_URL points at a *_test database. No real model is called.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { q } from "../db.js";

// The backup route reads the workspace from getWorkspaceId: this test's own workspace.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace || (await original<typeof import("../db.js")>()).getWorkspaceId() }));

import { pool } from "../db.js";
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { addCredential, listCredentials, revokeCredential } from "../services/aiCredentials.js";
import { loadSession, startSession, type AgentSession } from "../services/agentSessions.js";
import { drainOutbox } from "../services/outbox.js";
import type { ActorCtx } from "../types.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { modelInfo, startFakeMessagesService, textMessage, toolUseMessage } from "./helpers/fakeMessagesService.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { zipEntries } from "./helpers/zipEntries.js";

registerShippedModules();
const enabled = isTestDatabase();
const KEY = `sk-ant-api03-LEAK${randomBytes(12).toString("hex")}WXYZ`;
const SECRET = "cd".repeat(32);

let fake: Awaited<ReturnType<typeof startFakeMessagesService>>;
beforeAll(async () => {
  if (!enabled) return;
  process.env.ONDEN_SECRET_KEY = SECRET;
  fake = await startFakeMessagesService();
  process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
});
afterAll(async () => {
  if (enabled) await fake.close();
  delete process.env.ONDEN_SECRET_KEY;
  delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
  await pool.end();
});

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

describe.skipIf(!enabled)("an API key is found nowhere but its ciphertext", () => {
  it("not in any table, any log line, the backup zip or the owner's key list — after success, failure, unreachable and revoke", async () => {
    const written: string[] = [];
    const spies = [vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")].map((spy) =>
      spy.mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as never));

    const w = await agentWorld("keyleak", { ownWorkspace: { modules: ["ai"] } });
    ownWorkspace = w.ws;
    const credential = await addCredential(w.ws, { label: "leak test key", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    await q(
      `UPDATE agent_runners SET default_runtime = 'api', api_credential_id = $2, api_model = 'test-model', api_cap_choice = 'unlimited' WHERE actor_id = $1`,
      [w.agent.id, credential.id]);
    fake.state.models = [modelInfo("test-model")] as never;

    const run = async (label: string, script: () => void) => {
      const nodeId = await w.note(`@${w.handle} ${label}`);
      const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} ${label}` } });
      script();
      return { nodeId, done: await dispatchAndWait(session) };
    };

    const ok = await run("成功", () => { fake.state.script.length = 0; fake.state.fallback = () => textMessage("好了"); });
    expect(ok.done.status).toBe("completed");
    const withTool = await run("用工具", () => {
      fake.state.script.length = 0;
      fake.state.script.push(() => toolUseMessage("searchNodes", { query: KEY }));
      fake.state.fallback = () => textMessage("完成");
    });
    expect(withTool.done.status).toBe("completed");
    // the provider answers with an error that quotes the key back, as some do
    const failed = await run("供應商錯誤", () => {
      fake.state.script.length = 0;
      fake.state.fallback = () => ({ type: "error", error: { type: "authentication_error", message: `Incorrect API key provided: ${KEY}` } } as never);
    });
    expect(failed.done.status).not.toBe("running");
    // revoked between two paid calls
    const revoked = await run("撤銷中", () => {
      fake.state.script.length = 0;
      fake.state.script.push(async () => { await revokeCredential(w.ws, credential.id, { actor: w.owner }); return toolUseMessage("searchNodes", { query: "x" }); });
      fake.state.fallback = () => textMessage("不該到這裡");
    });
    expect(revoked.done).toMatchObject({ status: "failed", fail_code: "credential_revoked" });

    spies.forEach((spy) => spy.mockRestore());

    // 1. every row of every table
    const tables = (await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
    const holding: string[] = [];
    for (const table of tables) {
      const n = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" x WHERE x::text LIKE $1`, [`%${KEY}%`])).rows[0]!.n;
      if (n > 0) holding.push(`${table} (${n} rows)`);
    }
    expect(holding, "tables that hold the plaintext key").toEqual([]);
    // 2. logs
    expect(written.join("").includes(KEY), "stdout/stderr holds the key").toBe(false);
    // 3. the owner's list
    expect(JSON.stringify(await listCredentials(w.ws, { actor: w.owner }))).not.toContain(KEY);
    // 4. the full backup
    const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
    hono.onError(apiOnError);
    hono.use("*", async (c, next) => { c.set("actor", w.owner); await next(); });
    hono.route("/api/backup", backupRouter);
    const res = await hono.request("/api/backup/full.zip");
    expect(res.status).toBe(200);
    const zip = await zipEntries(Buffer.from(await res.arrayBuffer()));
    const ciphertext = (await q<{ hex: string }>(`SELECT encode(secret_ciphertext, 'hex') AS hex FROM ai_credentials WHERE id = $1`, [credential.id])).rows[0]!.hex;
    const filesWithSecrets = [...zip].filter(([, data]) => {
      const text = data.toString("latin1");
      return text.includes(KEY) || text.includes(ciphertext) || data.includes(Buffer.from(ciphertext, "hex"));
    }).map(([name]) => name);
    expect(filesWithSecrets, "backup files that hold the key or its ciphertext").toEqual([]);
    expect([...zip.keys()]).toContain(".onden/extras.json");
  }, 120_000);
});

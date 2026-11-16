// The program that answers for a person's own AI tool (packages/ai-answerer), against the real routes:
// pending → claim → ack → tool → finish, with a stand-in executable for the tool. The tool's own safety
// flags are proved in the package's adapter test; here the question is whether the loop and the
// server agree: answered, failed, timed out, cancelled, finish retried, one question at a time.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { cancel, configureRunner, loadSession, startSession } from "../services/agentSessions.js";
// @ts-expect-error — a plain .mjs program with no declaration file (packages/ai-answerer; same as browserShimsCrypto.test.ts)
import { createAdapters, createClient, runLoop } from "../../../ai-answerer/src/index.mjs";
// @ts-expect-error — plain .mjs, see above
import { writeFakeTool } from "../../../ai-answerer/src/testing/fakeTool.mjs";
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

const BASE = "http://onden.test";
type World = Awaited<ReturnType<typeof agentWorld>>;
type Adapter = { id: string; label: string; detect: () => Promise<unknown>; run: (input: { system: string; prompt: string; mcpUrl: string; sessionKey: string; deadline: number; signal?: AbortSignal }) => Promise<unknown> };

let tool = "";
let recordFile = "";
let toolDir = "";
afterAll(async () => { if (toolDir) await rm(toolDir, { recursive: true, force: true }); });
beforeAll(async () => {
  const dir = toolDir = await mkdtemp(join(tmpdir(), "answerer-it-"));
  tool = await writeFakeTool(dir);
  recordFile = join(dir, "record.json");
});

const toolEnv = (extra: Record<string, string> = {}) => ({ ...process.env, FAKE_TOOL_RECORD: recordFile, ...extra });
const realAdapter = (extra: Record<string, string> = {}) => createAdapters({ command: tool, env: toolEnv(extra) })[0]!;

async function codeFor(w: World) {
  return (await createToken(w.agent.id, { name: "connection code", access: "write", issuedBy: w.owner.id })).plaintext;
}
async function ask(w: World, text: string) {
  const md = `@${w.handle} ${text}`;
  const nodeId = await w.note(md);
  const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: md } });
  return { nodeId, session };
}
/** The app as `fetch`; `intercept` may answer a request itself. */
const appFetch = (intercept?: (url: string, init?: RequestInit) => Response | undefined) =>
  (async (url: string, init?: RequestInit) => intercept?.(url, init) ?? app.request(url, init)) as unknown as typeof fetch;

/** Run the loop until `done()` holds, then stop it. */
async function runUntil(w: World, adapter: Adapter, done: () => Promise<boolean>, opts: { fetch?: typeof fetch; log?: string[]; sleep?: (ms: number) => Promise<unknown> } = {}) {
  const controller = new AbortController();
  const sleep = opts.sleep;
  const client = createClient({ baseUrl: BASE, connectionCode: await codeFor(w), fetch: opts.fetch ?? appFetch(), sleep: async () => {} });
  const loop = runLoop({ client, adapter, baseUrl: BASE, signal: controller.signal, waitSeconds: 1, cancelPollMs: 150, log: (l: string) => opts.log?.push(l), ...(sleep ? { sleep } : {}) });
  const until = Date.now() + 25_000;
  while (!(await done()) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  await loop;
}
const statusOf = async (id: string) => (await loadSession(id))!.status;
const finished = (id: string) => async () => !["queued", "delivered", "running"].includes(await statusOf(id));

describe.skipIf(!isTestDb)("ai answering program against the backend", () => {
  it("answers: the reply lands in the note, the tool got the question and a session key that works against the MCP endpoint", async () => {
    const w = await agentWorld("ans-ok");
    const { nodeId, session } = await ask(w, "這則筆記在講什麼？");
    let mcpInitialize: Response | undefined;
    const adapter = realAdapter({ FAKE_TOOL_ANSWER: "這是答案" });
    const probing: Adapter = { ...adapter, run: async (input) => {
      mcpInitialize = await app.request(input.mcpUrl, {
        method: "POST", headers: { authorization: `Bearer ${input.sessionKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
      });
      return adapter.run(input);
    } };
    await runUntil(w, probing, finished(session.id));
    expect(await loadSession(session.id)).toMatchObject({ status: "completed" });
    expect(await w.body(nodeId)).toContain("這是答案");
    expect(mcpInitialize?.status).toBe(200);
    const record = JSON.parse(await (await import("node:fs/promises")).readFile(recordFile, "utf8"));
    expect(record.stdin).toContain("這則筆記在講什麼？");
  });

  it("fails the session (agent_error) when the tool reports an error, and keeps going", async () => {
    const w = await agentWorld("ans-fail");
    const { session } = await ask(w, "會失敗");
    await runUntil(w, realAdapter({ FAKE_TOOL_MODE: "error" }), finished(session.id));
    expect(await loadSession(session.id)).toMatchObject({ status: "failed", fail_code: "agent_error" });
  });

  it("kills a tool that runs past the session deadline and fails the session", async () => {
    const w = await agentWorld("ans-late");
    await configureRunner(w.ws, w.agent.id, { handle: w.handle, timeoutSeconds: 5 }, { actor: w.owner });
    const { session } = await ask(w, "太慢");
    const log: string[] = [];
    await runUntil(w, realAdapter({ FAKE_TOOL_MODE: "hang" }), finished(session.id), { log });
    expect(await loadSession(session.id)).toMatchObject({ status: "failed", fail_code: "agent_error" });
    expect(log.join("\n")).toContain("timeout");
  }, 30_000);

  it("stops the tool when the person cancels", async () => {
    const w = await agentWorld("ans-cancel");
    const { session } = await ask(w, "取消我");
    const adapter = realAdapter({ FAKE_TOOL_MODE: "hang" });
    const results: unknown[] = [];
    const watching: Adapter = { ...adapter, run: async (input) => {
      const result = await adapter.run(input);
      results.push(result);
      return result;
    } };
    let cancelled = false;
    await runUntil(w, watching, async () => {
      if (!cancelled && (await statusOf(session.id)) === "running") { cancelled = true; await cancel(session.id, { actor: w.owner }); }
      return results.length > 0;
    });
    expect(results).toEqual([{ ok: false, reason: "cancelled" }]);
    expect(await statusOf(session.id)).toBe("cancelled");
  });

  it("retries finish after a lost response and still completes exactly once", async () => {
    const w = await agentWorld("ans-retry");
    const { nodeId, session } = await ask(w, "重送");
    let finishCalls = 0;
    const flaky = appFetch((url) => {
      if (url.endsWith("/finish") && ++finishCalls <= 2) return new Response("{}", { status: 503 });
      return undefined;
    });
    await runUntil(w, realAdapter({ FAKE_TOOL_ANSWER: "只寫一次" }), finished(session.id), { fetch: flaky });
    expect(finishCalls).toBe(3);
    expect(await statusOf(session.id)).toBe("completed");
    const body = await w.body(nodeId);
    expect(body.split("只寫一次")).toHaveLength(2);
  });

  it("takes one question at a time: the second waits until the first is answered", async () => {
    const w = await agentWorld("ans-serial");
    const first = await ask(w, "第一個");
    const second = await ask(w, "第二個");
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const adapter = realAdapter();
    const gated: Adapter = { ...adapter, run: async (input) => {
      order.push(input.prompt.includes("第一個") ? "first" : "second");
      if (order.length === 1) await gate;
      return adapter.run(input);
    } };
    let probed = false;
    await runUntil(w, gated, async () => {
      if (order.length === 1 && !probed) {
        probed = true;
        await new Promise((r) => setTimeout(r, 600)); // long enough for a second claim if the loop were parallel
        expect(order).toEqual(["first"]);
        expect(await statusOf(second.session.id)).toBe("queued");
        release();
      }
      return (await statusOf(first.session.id)) === "completed" && (await statusOf(second.session.id)) === "completed";
    });
    expect(order).toEqual(["first", "second"]);
  });

  it("waits a minute when the connection code is refused, and never spins", async () => {
    const w = await agentWorld("ans-401");
    const waits: number[] = [];
    const controller = new AbortController();
    const client = createClient({ baseUrl: BASE, connectionCode: "ondt_wrong", fetch: appFetch() });
    await runLoop({
      client, adapter: realAdapter(), baseUrl: BASE, signal: controller.signal, waitSeconds: 1,
      sleep: async (ms: number) => { waits.push(ms); if (waits.length >= 2) controller.abort(); },
    });
    expect(waits).toEqual([60_000, 60_000]);
    void w;
  });
});

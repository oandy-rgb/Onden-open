import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canReuseWarmSession, extractOndenToolName } from "./acp.mjs";
import { createAntigravityAdapter } from "./antigravity.mjs";
import { createCodexAdapter } from "./codex.mjs";
import { createCopilotAdapter } from "./copilot.mjs";
import { createGeminiAdapter } from "./gemini.mjs";
import { ADAPTER_IDS, createAdapters, detectAdapter, inferAdapterId } from "./index.mjs";
import { createMcpAuthProxy } from "./mcpProxy.mjs";

const SESSION_KEY = "ondt_SESSIONKEY_987";
const ROLE_CODE = "ondt_ROLECODE_654";
const MCP_URL = "http://127.0.0.1:1/api/mcp/protocol";

let dir: string;
const prevTmpDir = process.env.TMPDIR;
const baseInput = (over: Record<string, unknown> = {}) => ({
  system: "SYSTEM PROMPT",
  prompt: "What is in this note?",
  mcpUrl: MCP_URL,
  sessionKey: SESSION_KEY,
  deadline: Date.now() + 10_000,
  ...over,
});

async function writeScript(name: string, body: string) {
  const file = join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\n${body}`);
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "adapters-multi-test-"));
  process.env.TMPDIR = dir;
});
afterAll(async () => {
  if (prevTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmpDir;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("codex adapter", () => {
  it("isolates CODEX_HOME (copies only auth.json), enforces read-only/ephemeral, parses JSONL, cleans up", async () => {
    const fakeHome = join(dir, "user-codex-home");
    await mkdir(fakeHome, { recursive: true });
    await writeFile(join(fakeHome, "auth.json"), JSON.stringify({ token: "user-login" }), { mode: 0o600 });
    await writeFile(join(fakeHome, "config.toml"), 'model = "personal-should-not-copy"\n');
    const record = join(dir, "codex-record.json");

    const fakeCodex = await writeScript("codex", `
      const fs = require("node:fs");
      const path = require("node:path");
      const args = process.argv.slice(2);
      if (args[0] === "--version") { console.log("codex-cli 0.42.0"); process.exit(0); }
      if (args[0] === "login" && args[1] === "status") {
        if (process.env.FAKE_LOGGED_IN === "no") { console.error("Not logged in"); process.exit(1); }
        console.log("Logged in using ChatGPT"); process.exit(0);
      }
      let stdin = "";
      process.stdin.on("data", (d) => { stdin += d; });
      process.stdin.on("end", () => {
        const home = process.env.CODEX_HOME;
        const configPath = path.join(home, "config.toml");
        const authPath = path.join(home, "auth.json");
        const configText = fs.readFileSync(configPath, "utf8");
        const configMode = fs.statSync(configPath).mode & 0o777;
        const authCopied = fs.existsSync(authPath);
        const sysMatch = configText.match(/model_instructions_file = "([^"]+)"/);
        const systemText = sysMatch ? fs.readFileSync(sysMatch[1], "utf8") : null;
        fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
          args, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env,
          codexHome: home, configPath, configText, configMode, authCopied, systemText, stdin,
        }));
        const mode = process.env.FAKE_MODE || "answer";
        if (mode === "hang") { setInterval(() => {}, 1000); return; }
        if (mode === "error") { console.log(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })); return; }
        if (mode === "garbage") { console.log("not json"); return; }
        console.log(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
        console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex says: " + stdin } }));
      });
    `);

    const env = (extra: Record<string, string> = {}) => ({
      ...process.env, CODEX_HOME: fakeHome, ONDEN_SECRET: ROLE_CODE, FAKE_RECORD: record, ...extra,
    });

    expect(await createCodexAdapter({ command: fakeCodex, env: env() }).detect()).toEqual({ ok: true, command: fakeCodex });
    expect(await createCodexAdapter({ command: fakeCodex, env: env({ FAKE_LOGGED_IN: "no" }) }).detect()).toMatchObject({ ok: false, reason: "not_logged_in" });

    const res = await createCodexAdapter({ command: fakeCodex, env: env() }).run(baseInput());
    expect(res).toEqual({ ok: true, text: "codex says: What is in this note?" });

    const r = JSON.parse(await readFile(record, "utf8"));
    expect(r.cwdEntries).toEqual([]);
    expect(r.args).toEqual(["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-"]);
    expect(r.codexHome).not.toBe(fakeHome);
    expect(r.authCopied).toBe(true);
    expect(r.configMode).toBe(0o600);
    expect(r.configText).toContain('sandbox_mode = "read-only"');
    expect(r.configText).toContain("shell_tool = false");
    expect(r.configText).toContain(SESSION_KEY);
    expect(r.configText).not.toContain("personal-should-not-copy");
    expect(r.systemText).toBe("SYSTEM PROMPT");
    expect(r.stdin).toBe("What is in this note?");
    expect(JSON.stringify(r.args)).not.toContain(SESSION_KEY);
    expect(JSON.stringify(r.env)).not.toContain(SESSION_KEY);
    expect(Object.keys(r.env).filter((k) => k.startsWith("ONDEN_"))).toEqual([]);
    expect(existsSync(r.cwd)).toBe(false);
    expect(existsSync(r.configPath)).toBe(false);

    expect(await createCodexAdapter({ command: fakeCodex, env: env({ FAKE_MODE: "error" }) }).run(baseInput())).toEqual({ ok: false, reason: "tool_error" });
    expect(await createCodexAdapter({ command: fakeCodex, env: env({ FAKE_MODE: "garbage" }) }).run(baseInput())).toEqual({ ok: false, reason: "not_json" });
    expect(await createCodexAdapter({ command: fakeCodex, env: env({ FAKE_MODE: "hang" }) }).run(baseInput({ deadline: Date.now() + 400 }))).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("gemini adapter", () => {
  it("injects 0600 system settings & system.md, blocks built-in tools, parses JSON response, cleans up", async () => {
    const record = join(dir, "gemini-record.json");
    const fakeGemini = await writeScript("gemini", `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      if (args[0] === "--version") { console.log("0.21.3"); process.exit(0); }
      let stdin = "";
      process.stdin.on("data", (d) => { stdin += d; });
      process.stdin.on("end", () => {
        const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
        const systemPath = process.env.GEMINI_SYSTEM_MD;
        fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
          args, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env,
          settingsPath, settingsText: fs.readFileSync(settingsPath, "utf8"), settingsMode: fs.statSync(settingsPath).mode & 0o777,
          systemText: fs.readFileSync(systemPath, "utf8"), systemMode: fs.statSync(systemPath).mode & 0o777, stdin,
        }));
        const mode = process.env.FAKE_MODE || "answer";
        if (mode === "hang") { setInterval(() => {}, 1000); return; }
        if (mode === "error") { console.log(JSON.stringify({ error: { message: "quota" } })); return; }
        if (mode === "garbage") { console.log("oops"); return; }
        console.log(JSON.stringify({ response: "gemini says: " + stdin }));
      });
    `);
    const env = (extra: Record<string, string> = {}) => ({ ...process.env, ONDEN_SECRET: ROLE_CODE, FAKE_RECORD: record, ...extra });

    expect(await createGeminiAdapter({ command: fakeGemini, env: env() }).detect()).toEqual({ ok: true, command: fakeGemini });
    const res = await createGeminiAdapter({ command: fakeGemini, env: env() }).run(baseInput());
    expect(res).toEqual({ ok: true, text: "gemini says: What is in this note?" });

    const r = JSON.parse(await readFile(record, "utf8"));
    expect(r.cwdEntries).toEqual([]);
    expect(r.args).toEqual(["-p", "", "--output-format", "json", "--allowed-mcp-server-names", "onden", "--extensions", "none"]);
    expect(r.settingsMode).toBe(0o600);
    expect(r.systemMode).toBe(0o600);
    expect(r.systemText).toBe("SYSTEM PROMPT");
    const settings = JSON.parse(r.settingsText);
    expect(settings.tools.core).toEqual([]);
    expect(settings.coreTools).toEqual([]);
    expect(settings.mcp.allowed).toEqual(["onden"]);
    expect(settings.mcpServers.onden.headers.Authorization).toBe(`Bearer ${SESSION_KEY}`);
    expect(JSON.stringify(r.args)).not.toContain(SESSION_KEY);
    expect(JSON.stringify(r.env)).not.toContain(SESSION_KEY);
    expect(Object.keys(r.env).filter((k) => k.startsWith("ONDEN_"))).toEqual([]);
    expect(existsSync(r.cwd)).toBe(false);
    expect(existsSync(r.settingsPath)).toBe(false);

    expect(await createGeminiAdapter({ command: fakeGemini, env: env({ FAKE_MODE: "error" }) }).run(baseInput())).toEqual({ ok: false, reason: "tool_error" });
    expect(await createGeminiAdapter({ command: fakeGemini, env: env({ FAKE_MODE: "garbage" }) }).run(baseInput())).toEqual({ ok: false, reason: "not_json" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect(await createGeminiAdapter({ command: fakeGemini, env: env({ FAKE_MODE: "hang" }) }).run(baseInput({ signal: ac.signal }))).toEqual({ ok: false, reason: "cancelled" });
  });
});

function fakeAcpScript() {
  return `
    const fs = require("node:fs");
    const readline = require("node:readline");
    const args = process.argv.slice(2);
    if (args.includes("--version")) {
      if (process.env.FAKE_SHIM === "1") { console.log("Install CLI? [y/N]"); process.exit(0); }
      console.log("1.2.3");
      process.exit(0);
    }
    const rl = readline.createInterface({ input: process.stdin });
    const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
    const log = { args, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env, init: null, sessionNew: null, prompt: null, permShell: null, permOnden: null };
    let promptReqId = null;
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        log.init = msg.params;
        send({ id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === "session/new") {
        log.sessionNew = msg.params;
        if (process.env.FAKE_MODE === "error") { send({ id: msg.id, error: { code: -32000, message: "auth required" } }); return; }
        send({ id: msg.id, result: { sessionId: "sess-1" } });
      } else if (msg.method === "session/prompt") {
        log.prompt = msg.params;
        promptReqId = msg.id;
        if (process.env.FAKE_MODE === "hang") return;
        // Ask permission for a dangerous built-in shell call AND a valid Onden MCP call
        send({ id: 101, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { title: "shell", kind: "execute" }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_always" }] } });
        send({ id: 102, method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { _meta: { is_mcp_tool_call: true, mcp: { server: "onden", tool: "getNode" } } }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_always" }] } });
      } else if (msg.id === 101) {
        log.permShell = msg.result;
      } else if (msg.id === 102) {
        log.permOnden = msg.result;
        fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(log));
        send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp answer: " } } } });
        send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
        send({ id: promptReqId, result: { stopReason: "end_turn" } });
      }
    });
  `;
}

describe("copilot adapter (ACP)", () => {
  it("runs via ACP with deny-tool flags, rejects installer shims without semver, enforces fail-closed permissions", async () => {
    const record = join(dir, "copilot-record.json");
    const fakeCopilot = await writeScript("copilot", fakeAcpScript());
    const env = (extra: Record<string, string> = {}) => ({ ...process.env, ONDEN_SECRET: ROLE_CODE, FAKE_RECORD: record, ...extra });

    expect(await createCopilotAdapter({ command: fakeCopilot, env: env({ FAKE_SHIM: "1" }) }).detect()).toMatchObject({ ok: false, reason: "missing" });
    expect(await createCopilotAdapter({ command: fakeCopilot, env: env() }).detect()).toEqual({ ok: true, command: fakeCopilot });

    const beforeTmp = readdirSync(tmpdir()).filter((n) => n.startsWith("onden-ai-")).length;
    const res = await createCopilotAdapter({ command: fakeCopilot, env: env() }).run(baseInput());
    expect(res).toEqual({ ok: true, text: "acp answer: ok" });

    const r = JSON.parse(await readFile(record, "utf8"));
    expect(r.cwdEntries).toEqual([]);
    expect(r.args).toContain("--acp");
    expect(r.args).toContain("--deny-tool=shell");
    expect(r.args).toContain("--disable-builtin-mcps");
    expect(r.args).toContain("--no-custom-instructions");
    expect(r.args).toContain("--no-auto-update");
    expect(r.init.clientCapabilities).toEqual({});
    expect(r.sessionNew.mcpServers).toEqual([{ name: "onden", type: "http", url: MCP_URL, headers: [{ name: "Authorization", value: `Bearer ${SESSION_KEY}` }] }]);
    expect(r.permShell).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(r.permOnden).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(JSON.stringify(r.args)).not.toContain(SESSION_KEY);
    expect(JSON.stringify(r.env)).not.toContain(SESSION_KEY);
    expect(Object.keys(r.env).filter((k) => k.startsWith("ONDEN_"))).toEqual([]);
    expect(existsSync(r.cwd)).toBe(false);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("onden-ai-")).length).toBe(beforeTmp);

    expect(await createCopilotAdapter({ command: fakeCopilot, env: env({ FAKE_MODE: "error" }) }).run(baseInput())).toEqual({ ok: false, reason: "tool_error" });
    expect(await createCopilotAdapter({ command: fakeCopilot, env: env({ FAKE_MODE: "hang" }) }).run(baseInput({ deadline: Date.now() + 400 }))).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("antigravity adapter (ACP)", () => {
  it("supports both `agy` (with `acp` subcommand) and standalone `agy_acp_server.par` (no subcommand)", async () => {
    const recordAgy = join(dir, "agy-record.json");
    const recordPar = join(dir, "par-record.json");
    const fakeAgy = await writeScript("agy", fakeAcpScript());
    const fakePar = await writeScript("agy_acp_server.par", fakeAcpScript());

    const envAgy = { ...process.env, ONDEN_SECRET: ROLE_CODE, FAKE_RECORD: recordAgy };
    const envPar = { ...process.env, ONDEN_SECRET: ROLE_CODE, FAKE_RECORD: recordPar };

    expect(await createAntigravityAdapter({ command: fakeAgy, env: envAgy }).detect()).toEqual({ ok: true, command: fakeAgy });
    expect(await createAntigravityAdapter({ command: fakeAgy, env: envAgy }).run(baseInput())).toEqual({ ok: true, text: "acp answer: ok" });
    const rAgy = JSON.parse(await readFile(recordAgy, "utf8"));
    expect(rAgy.args).toEqual(["acp", "--sandbox", "--include-default-customizations=false", "--disable-telemetry"]);
    expect(rAgy.permShell).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(rAgy.permOnden).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

    expect(await createAntigravityAdapter({ command: fakePar, env: envPar }).detect()).toEqual({ ok: true, command: fakePar });
    expect(await createAntigravityAdapter({ command: fakePar, env: envPar }).run(baseInput())).toEqual({ ok: true, text: "acp answer: ok" });
    const rPar = JSON.parse(await readFile(recordPar, "utf8"));
    expect(rPar.args).toEqual([]);
    expect(existsSync(rPar.cwd)).toBe(false);
  });
});

describe("adapter registry & auto-detection", () => {
  it("registers all 5 adapters with claude-code first and infers adapter ids from executable names", () => {
    expect(ADAPTER_IDS).toEqual(["claude-code", "codex", "gemini", "antigravity", "copilot"]);
    expect(createAdapters().map((a) => a.id)).toEqual([...ADAPTER_IDS]);
    expect(inferAdapterId("/usr/local/bin/codex")).toBe("codex");
    expect(inferAdapterId("gemini")).toBe("gemini");
    expect(inferAdapterId("/opt/agy/agy_acp_server.par")).toBe("antigravity");
    expect(inferAdapterId("agy")).toBe("antigravity");
    expect(inferAdapterId("copilot")).toBe("copilot");
    expect(inferAdapterId("/tmp/fake-ai-tool")).toBe("claude-code");
  });

  it("auto-detects whichever supported CLI is on PATH and rejects unknown --tool names", async () => {
    const binDir = join(dir, "only-gemini-bin");
    await mkdir(binDir, { recursive: true });
    const geminiBin = join(binDir, "gemini");
    await writeFile(geminiBin, "#!/usr/bin/env node\nconsole.log('0.21.3');\n");
    await chmod(geminiBin, 0o755);

    const found = await detectAdapter({ env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` } });
    if (found.ok && found.command === geminiBin) {
      expect(found.adapter.id).toBe("gemini");
    }

    const explicit = await detectAdapter({ tool: "gemini", command: geminiBin, env: process.env });
    expect(explicit).toMatchObject({ ok: true, command: geminiBin });
    if (explicit.ok) expect(explicit.adapter.id).toBe("gemini");

    const unknown = await detectAdapter({ tool: "unknown-cli" });
    expect(unknown).toMatchObject({ ok: false, reason: "missing" });
  });
});

describe("warm ACP session reuse, local MCP auth proxy, and live progress", () => {
  it("MCP auth proxy swaps per-turn Bearer tokens in memory and returns 401 when idle or 404 on wrong path", async () => {
    const seenAuth: string[] = [];
    const upstream = createServer((req, res) => {
      seenAuth.push(String(req.headers.authorization ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/mcp/protocol`;
    const proxy = await createMcpAuthProxy();
    try {
      // Idle -> 401, wrong path -> 404
      expect((await fetch(proxy.url, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(proxy.url.replace(/\/mcp-.*/, "/wrong"), { method: "POST" })).status).toBe(404);

      proxy.setTarget(upstreamUrl, "ondt_TURN_1");
      expect((await fetch(proxy.url, { method: "POST", headers: { authorization: "Bearer spoofed" }, body: "{}" })).status).toBe(200);
      proxy.setTarget(upstreamUrl, "ondt_TURN_2");
      expect((await fetch(proxy.url, { method: "POST", body: "{}" })).status).toBe(200);
      proxy.clearTarget();
      expect((await fetch(proxy.url, { method: "POST", body: "{}" })).status).toBe(401);
      expect(seenAuth).toEqual(["Bearer ondt_TURN_1", "Bearer ondt_TURN_2"]);
    } finally {
      await proxy.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  it("reuses warm ACP subprocess & sessionId for consecutive turns of the same thread, resets on note/clear change, and streams progress", async () => {
    const fakeWarmAgy = await writeScript("agy-warm", `
      const http = require("node:http");
      const readline = require("node:readline");
      const args = process.argv.slice(2);
      if (args.includes("--version")) { console.log("1.5.16"); process.exit(0); }
      const rl = readline.createInterface({ input: process.stdin });
      const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
      let seq = 0;
      let mcpUrl = "";
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === "session/new") {
          mcpUrl = msg.params.mcpServers[0].url;
          seq++;
          send({ id: msg.id, result: { sessionId: "warm-sess-" + seq } });
        } else if (msg.method === "session/prompt") {
          const sid = msg.params.sessionId;
          const text = msg.params.prompt[0].text;
          send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", name: "mcp_onden_getNode" } } });
          const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turn: text }) });
          const body = await res.json();
          send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: pidReply(process.pid, sid, body.auth, text) } } } });
          send({ id: msg.id, result: { stopReason: "end_turn" } });
        }
      });
      function pidReply(pid, sid, auth, text) { return pid + "|" + sid + "|" + auth + "|" + text.trim(); }
    `);

    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ auth: req.headers.authorization }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const mcpUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/mcp/protocol`;

    const adapter = createAntigravityAdapter({ command: fakeWarmAgy, env: process.env });
    try {
      const progress: Array<{ kind: string; tool?: string; text?: string }> = [];
      const threadA = JSON.stringify(["space-1", "note-1", "agent-1", "user-1", "SYSTEM"]);
      const threadB = JSON.stringify(["space-1", "note-2", "agent-1", "user-1", "SYSTEM"]);

      // Turn 1 on thread A -> creates warm-sess-1
      const t1 = await adapter.run({
        system: "SYSTEM", prompt: "Q1", mcpUrl, sessionKey: "ondt_KEY_1", deadline: Date.now() + 10_000,
        threadKey: threadA, messages: [{ role: "user", content: "Q1" }],
        onProgress: (ev) => progress.push(ev),
      });
      expect(t1.ok).toBe(true);
      if (!t1.ok) return;
      const [pid1, sid1, auth1] = t1.text.split("|");
      expect(sid1).toBe("warm-sess-1");
      expect(auth1).toBe("Bearer ondt_KEY_1");
      expect(progress.some((p) => p.kind === "action" && p.tool === "getNode")).toBe(true);
      expect(progress.some((p) => p.kind === "message" && p.text === t1.text)).toBe(true);

      // Turn 2 on SAME thread A (messages extends Turn 1 with prior assistant answer) -> REUSES pid1 + warm-sess-1, swaps to KEY_2!
      const t2 = await adapter.run({
        system: "SYSTEM", prompt: "ignored-full-prompt", mcpUrl, sessionKey: "ondt_KEY_2", deadline: Date.now() + 10_000,
        threadKey: threadA,
        messages: [
          { role: "user", content: "<request>\nQ1\n</request>" },
          { role: "assistant", content: t1.text },
          { role: "user", content: "Q2-ONLY" },
        ],
      });
      expect(t2.ok).toBe(true);
      if (!t2.ok) return;
      const [pid2, sid2, auth2, sentText2] = t2.text.split("|");
      expect(pid2).toBe(pid1);
      expect(sid2).toBe("warm-sess-1");
      expect(auth2).toBe("Bearer ondt_KEY_2");
      expect(sentText2).toBe("Q2-ONLY");

      // Turn 3 on DIFFERENT note (thread B) -> REUSES warm process pid1, but opens BRAND NEW warm-sess-2!
      const t3 = await adapter.run({
        system: "SYSTEM", prompt: "Q3", mcpUrl, sessionKey: "ondt_KEY_3", deadline: Date.now() + 10_000,
        threadKey: threadB, messages: [{ role: "user", content: "Q3" }],
      });
      expect(t3.ok).toBe(true);
      if (!t3.ok) return;
      const [pid3, sid3, auth3] = t3.text.split("|");
      expect(pid3).toBe(pid1);
      expect(sid3).toBe("warm-sess-2");
      expect(auth3).toBe("Bearer ondt_KEY_3");

      // Cleared chat (messages.length === 1 on same threadB) -> opens fresh warm-sess-3!
      expect(canReuseWarmSession({ sessionId: "warm-sess-2", threadKey: threadB, lastAnswer: t3.text }, { threadKey: threadB, messages: [{ role: "user", content: "fresh" }] })).toBe(false);
      expect(extractOndenToolName({ name: "mcp_onden_searchNodes" })).toBe("searchNodes");
      expect(extractOndenToolName({ name: "read_file" })).toBe(null);
    } finally {
      await adapter.dispose?.();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

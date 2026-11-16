import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { writeFakeTool } from "../testing/fakeTool.mjs";
import { createClaudeCodeAdapter } from "./claudeCode.mjs";

const SESSION_KEY = "ondt_SESSIONKEY_123";
const ROLE_CODE = "ondt_ROLECODE_456";
let dir: string, tool: string, record: string;
const env = (extra: Record<string, string> = {}) => ({ ...process.env, ONDEN_AI_KEY_FILE: "/secret/path", ONDEN_CODE_IN_ENV: ROLE_CODE, FAKE_TOOL_RECORD: record, ...extra });
const input = (over: Record<string, unknown> = {}) => ({ system: "SYSTEM TEXT", prompt: "the question", mcpUrl: "http://127.0.0.1:1/api/mcp/protocol", sessionKey: SESSION_KEY, deadline: Date.now() + 10_000, ...over });
const recorded = async () => JSON.parse(await readFile(record, "utf8"));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "adapter-test-"));
  tool = await writeFakeTool(dir);
  record = join(dir, "record.json");
});

describe("claude code adapter", () => {
  it("runs the tool once, sealed in: empty cwd, no built-in tools, our MCP only, no settings, key only in a private file", async () => {
    const result = await createClaudeCodeAdapter({ command: tool, env: env() }).run(input());
    expect(result).toEqual({ ok: true, text: "answer: the question" });
    const r = await recorded();

    expect(r.cwdEntries).toEqual([]); // fresh and empty
    expect(r.cwd).not.toBe(process.cwd());
    const at = (flag: string) => r.args[r.args.indexOf(flag) + 1];
    expect(r.args).toContain("-p");
    expect(at("--output-format")).toBe("json");
    expect(at("--tools")).toBe(""); // no built-in tools
    expect(r.args).toContain("--strict-mcp-config");
    expect(at("--setting-sources")).toBe(""); // no personal settings, hooks, memory, project files
    expect(r.args).toContain("--no-session-persistence");
    expect(at("--allowedTools")).toBe("mcp__onden");
    expect(r.args.filter((a: string) => a === "--allowedTools")).toHaveLength(1);
    expect(at("--system-prompt")).toBe("SYSTEM TEXT");
    expect(r.stdin).toBe("the question"); // the prompt on stdin, not in arguments
    expect(r.args.join(" ")).not.toContain("the question");

    // the key is only inside the 0600 file, outside the working directory
    expect(r.configMode).toBe(0o600);
    expect(JSON.parse(r.configText)).toEqual({ mcpServers: { onden: { type: "http", url: "http://127.0.0.1:1/api/mcp/protocol", headers: { Authorization: `Bearer ${SESSION_KEY}` } } } });
    expect(r.configFile.startsWith(r.cwd)).toBe(false);
    expect(JSON.stringify(r.args)).not.toContain(SESSION_KEY);
    expect(JSON.stringify(r.env)).not.toContain(SESSION_KEY);
    // nothing of ours reaches the tool's environment
    expect(Object.keys(r.env).filter((n) => n.startsWith("ONDEN_"))).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(ROLE_CODE);

    // and the temp directory is gone afterwards
    expect(existsSync(r.configFile)).toBe(false);
    expect(existsSync(r.cwd)).toBe(false);
  });

  it("reports a tool error, unreadable output and a missing tool without throwing", async () => {
    expect(await createClaudeCodeAdapter({ command: tool, env: env({ FAKE_TOOL_MODE: "error" }) }).run(input())).toEqual({ ok: false, reason: "tool_error" });
    expect(await createClaudeCodeAdapter({ command: tool, env: env({ FAKE_TOOL_MODE: "garbage" }) }).run(input())).toEqual({ ok: false, reason: "not_json" });
    expect(await createClaudeCodeAdapter({ command: join(dir, "nope"), env: env() }).run(input())).toEqual({ ok: false, reason: "not_started" });
  });

  it("kills the tool at the deadline and when told to stop, and still removes the temp directory", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("onden-ai-")).length;
    const started = Date.now();
    expect(await createClaudeCodeAdapter({ command: tool, env: env({ FAKE_TOOL_MODE: "hang" }) }).run(input({ deadline: Date.now() + 600 }))).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    expect(await createClaudeCodeAdapter({ command: tool, env: env({ FAKE_TOOL_MODE: "hang" }) }).run(input({ signal: controller.signal }))).toEqual({ ok: false, reason: "cancelled" });
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("onden-ai-")).length).toBe(before);
  });

  it("says in plain words when the tool is missing or not logged in", async () => {
    expect(await createClaudeCodeAdapter({ command: join(dir, "nope"), env: env() }).detect()).toMatchObject({ ok: false, message: expect.stringContaining("找不到") });
    expect(await createClaudeCodeAdapter({ command: tool, env: env({ FAKE_TOOL_LOGGED_IN: "no" }) }).detect()).toMatchObject({ ok: false, message: expect.stringContaining("還沒登入") });
    expect(await createClaudeCodeAdapter({ command: tool, env: env() }).detect()).toEqual({ ok: true, command: tool });
  });

  it("finds the tool as an absolute path from a given path, PATH, or not at all", async () => {
    const detect = (command: string, PATH: string) => createClaudeCodeAdapter({ command, env: env({ PATH }) }).detect();
    const withNode = `${dir}:${process.env.PATH}`;
    expect(await detect(tool, withNode)).toEqual({ ok: true, command: tool });
    expect(await detect("fake-ai-tool", withNode)).toEqual({ ok: true, command: tool });
    expect(await detect("fake-ai-tool-absent", withNode)).toMatchObject({ ok: false, message: expect.stringContaining("找不到") });
  });

  it("detect reports the absolute path to install into a service that has no PATH of ours", async () => {
    const found = await createClaudeCodeAdapter({ command: "fake-ai-tool", env: env({ PATH: `${dir}:${process.env.PATH}` }) }).detect();
    expect(found).toEqual({ ok: true, command: tool });
  });
});

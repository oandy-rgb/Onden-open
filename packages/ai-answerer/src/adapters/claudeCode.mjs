// The one shipped adapter: the Claude Code command-line tool, already logged in on this computer.
//
// SAFETY (owner rule, 2026-11-15; guard: safety.guard.test.ts). The note a question comes from is
// untrusted text and may contain instructions, so the tool is started so that it can do nothing on
// this computer: no built-in tools (no files, shell or web), no personal settings, hooks, memory or
// project files, and no MCP servers except Onden's, reached with a key that dies with the session.
// Each flag below is one of those guarantees; removing one fails the guard test.
// Checked against the real tool (version 2.1.311, 2026-11-16) with exactly these flags: a hook in the personal
// settings and one in the working directory's settings did not run (both ran without --setting-sources ""), a
// CLAUDE.md planted in the working directory was not read, and the tool reported no tools it could call.
// Not checked: a personal memory file in the home directory. Check again when the tool's major version changes.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { access, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { parseToolOutput } from "../prompt.mjs";

/** The flags that keep the tool harmless; `claudeArgs` always includes all of them. */
export const SAFETY_FLAGS = Object.freeze({
  noBuiltInTools: ["--tools", ""],
  onlyOurMcpServers: ["--strict-mcp-config"],
  onlyOurMcpTools: ["--allowedTools", "mcp__onden"],
  noPersonalSettings: ["--setting-sources", ""],
  nothingKept: ["--no-session-persistence"],
});

/** @param {{ configFile: string, system: string }} input */
export function claudeArgs({ configFile, system }) {
  return [
    "-p", "--output-format", "json",
    ...SAFETY_FLAGS.nothingKept,
    ...SAFETY_FLAGS.noBuiltInTools,
    ...SAFETY_FLAGS.onlyOurMcpServers, "--mcp-config", configFile,
    ...SAFETY_FLAGS.onlyOurMcpTools,
    ...SAFETY_FLAGS.noPersonalSettings,
    "--system-prompt", system,
  ];
}

/** The per-session MCP config. The session key lives only here (a 0600 file), never in arguments or environment. */
export const mcpConfigJson = (/** @type {string} */ mcpUrl, /** @type {string} */ sessionKey) => JSON.stringify({
  mcpServers: { onden: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${sessionKey}` } } },
});

/** Our own settings are not the tool's business: nothing named ONDEN_* reaches it. */
export function childEnvironment(/** @type {NodeJS.ProcessEnv} */ env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("ONDEN_")));
}

/** Where AI tools usually live when the program was not started from a shell (a systemd user service and a desktop app get a short PATH). */
const COMMON_TOOL_DIRS = () => [join(homedir(), ".local/bin"), join(homedir(), ".npm-global/bin"), join(homedir(), ".claude/local"), "/home/linuxbrew/.linuxbrew/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/** @param {string} file */
const isExecutable = (file) => new Promise((resolve) => access(file, constants.X_OK, (error) => resolve(!error)));

/**
 * The tool as an absolute path, or null: a path is checked as given; a bare name is looked up in PATH, then in the
 * usual install folders. A background service must be started with this path, not the name.
 * @param {string} command @param {NodeJS.ProcessEnv} env @returns {Promise<string | null>}
 */
async function resolveExecutable(command, env) {
  if (isAbsolute(command) || command.includes("/")) return (await isExecutable(command)) ? command : null;
  for (const dir of [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...COMMON_TOOL_DIRS()]) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** @param {string} command @param {string[]} args @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options] */
function runToEnd(command, args, { env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(command, args, { env: childEnvironment(env), stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, out, error }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, error: null }); });
  });
}

/**
 * @param {{ command?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {import("./index.mjs").Adapter}
 */
export function createClaudeCodeAdapter({ command = "claude", env = process.env } = {}) {
  return {
    id: "claude-code",
    label: "Claude Code",
    async detect() {
      const found = await resolveExecutable(command, env);
      const version = found ? /** @type {any} */ (await runToEnd(found, ["--version"], { env })) : { error: true };
      if (!found || version.error || version.code !== 0) {
        return { ok: false, reason: "missing", message: `在這台電腦上找不到命令列 AI 工具（${command}）。請先安裝它並登入，再重新開始。` };
      }
      // `auth status` prints JSON with `loggedIn`. An older tool without it is "installed, login not checked".
      const auth = /** @type {any} */ (await runToEnd(found, ["auth", "status"], { env }));
      try {
        if (JSON.parse(auth.out).loggedIn === false) {
          return { ok: false, reason: "not_logged_in", message: "命令列 AI 工具還沒登入。請在終端機執行它並完成登入，再重新開始。" };
        }
      } catch { /* not JSON: cannot tell; the first question will show it */ }
      return { ok: true, command: found };
    },
    async run({ system, prompt, mcpUrl, sessionKey, deadline, signal }) {
      const exe = await resolveExecutable(command, env);
      if (!exe) return { ok: false, reason: "not_started" };
      const root = await mkdtemp(join(tmpdir(), "onden-ai-"));
      try {
        await chmod(root, 0o700);
        const work = join(root, "work"); // the tool's working directory: empty
        const configDir = join(root, "config");
        await mkdir(work); await mkdir(configDir);
        const configFile = join(configDir, "mcp.json");
        await writeFile(configFile, mcpConfigJson(mcpUrl, sessionKey), { mode: 0o600 });
        await chmod(configFile, 0o600);

        return await new Promise((resolve) => {
          const child = spawn(exe, claudeArgs({ configFile, system }), {
            cwd: work, env: childEnvironment(env), stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32",
          });
          let out = "";
          let ended = false;
          const end = (/** @type {any} */ result) => { if (!ended) { ended = true; clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve(result); } };
          const kill = () => {
            const pid = child.pid;
            try { if (pid === undefined || process.platform === "win32") child.kill("SIGKILL"); else process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          };
          const stop = () => { kill(); end({ ok: false, reason: "cancelled" }); };
          const timer = setTimeout(() => { kill(); end({ ok: false, reason: "timeout" }); }, Math.max(0, deadline - Date.now()));
          if (signal?.aborted) return stop();
          signal?.addEventListener("abort", stop);
          child.stdout.on("data", (d) => { out += d; if (out.length > 5_000_000) { kill(); end({ ok: false, reason: "too_long" }); } });
          child.on("error", () => end({ ok: false, reason: "not_started" }));
          child.on("close", () => end(parseToolOutput(out)));
          child.stdin.on("error", () => {});
          child.stdin.end(prompt);
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

// Adapter for the Google Gemini CLI (`gemini`), already logged in on this computer.
//
// SAFETY (owner rule, 2026-11-15; guard: safety.guard.test.ts):
//   - Starts in a fresh empty working directory (`cwd: work`), removed on exit.
//   - Injects a highest-precedence 0600 system settings file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`:
//     clears built-in `tools.core` / `coreTools`, explicitly excludes built-in file/shell/web/memory tools,
//     restricts `mcp.allowed` to `["onden"]`, disables session retention, and supplies Onden's MCP server
//     with the per-session key only inside this 0600 file (never in CLI arguments or environment variables).
//   - Passes `--allowed-mcp-server-names onden` and `--extensions none` so personal MCP servers & extensions cannot load.
//   - System prompt lives in a 0600 file via `GEMINI_SYSTEM_MD`; user prompt is sent on stdin (`-p ""`).
// Note: verified against Gemini CLI's documented headless & settings contract; verify again on a real install
// after major Gemini CLI upgrades.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnvironment, resolveExecutable, runToEnd, spawnBounded, withIsolatedRunDir } from "./runtime.mjs";

export const GEMINI_EXCLUDED_BUILTIN_TOOLS = Object.freeze([
  "run_shell_command",
  "read_file",
  "write_file",
  "replace",
  "list_directory",
  "glob",
  "grep",
  "search_file_content",
  "web_fetch",
  "google_web_search",
  "save_memory",
]);

/** The flags that keep Gemini CLI harmless; `geminiArgs` always includes all of them. */
export const GEMINI_SAFETY_FLAGS = Object.freeze({
  headlessFromStdin: ["-p", ""],
  jsonOutput: ["--output-format", "json"],
  onlyOurMcpServer: ["--allowed-mcp-server-names", "onden"],
  noExtensions: ["--extensions", "none"],
});

export function geminiArgs() {
  return [
    ...GEMINI_SAFETY_FLAGS.headlessFromStdin,
    ...GEMINI_SAFETY_FLAGS.jsonOutput,
    ...GEMINI_SAFETY_FLAGS.onlyOurMcpServer,
    ...GEMINI_SAFETY_FLAGS.noExtensions,
  ];
}

/** Generate the highest-precedence 0600 system settings JSON for one session.
 * Includes both nested `tools` (v0.2+) and legacy top-level `coreTools`/`excludeTools` for defense in depth.
 * @param {string} mcpUrl @param {string} sessionKey
 */
export function geminiSettingsJson(mcpUrl, sessionKey) {
  return JSON.stringify({
    tools: {
      core: [],
      exclude: [...GEMINI_EXCLUDED_BUILTIN_TOOLS],
    },
    coreTools: [],
    excludeTools: [...GEMINI_EXCLUDED_BUILTIN_TOOLS],
    mcp: {
      allowed: ["onden"],
    },
    mcpServers: {
      onden: {
        httpUrl: mcpUrl,
        headers: { Authorization: `Bearer ${sessionKey}` },
        trust: true,
      },
    },
    general: {
      sessionRetention: { enabled: false },
    },
  });
}

/**
 * Parse `gemini --output-format json` stdout (`{ response, error }`).
 * @param {string} stdout
 * @returns {{ ok: true, text: string } | { ok: false, reason: "empty" | "not_json" | "tool_error" }}
 */
export function parseGeminiOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  /** @type {any} */
  let value;
  try { value = JSON.parse(trimmed); } catch { return { ok: false, reason: "not_json" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not_json" };
  if (value.error || value.is_error === true) return { ok: false, reason: "tool_error" };
  const text = typeof value.response === "string" ? value.response.trim() : "";
  return text ? { ok: true, text } : { ok: false, reason: "empty" };
}

/**
 * @param {{ command?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {import("./index.mjs").Adapter}
 */
export function createGeminiAdapter({ command = "gemini", env = process.env } = {}) {
  return {
    id: "gemini",
    label: "Gemini CLI",
    async detect() {
      const found = await resolveExecutable(command, env);
      const version = found ? await runToEnd(found, ["--version"], { env }) : { code: null, out: "", err: "", error: new Error("missing") };
      if (!found || version.error || version.code !== 0 || !/\d+\.\d+\.\d+/.test(`${version.out}\n${version.err}`)) {
        return { ok: false, reason: "missing", message: `在這台電腦上找不到命令列 AI 工具（${command}）。請先安裝它並登入，再重新開始。` };
      }
      return { ok: true, command: found };
    },
    async run({ system, prompt, mcpUrl, sessionKey, deadline, signal }) {
      const exe = await resolveExecutable(command, env);
      if (!exe) return { ok: false, reason: "not_started" };
      return withIsolatedRunDir(async ({ work, configDir }) => {
        const systemFile = join(configDir, "system.md");
        await writeFile(systemFile, system, { mode: 0o600 });
        await chmod(systemFile, 0o600);
        const settingsFile = join(configDir, "settings.json");
        await writeFile(settingsFile, geminiSettingsJson(mcpUrl, sessionKey), { mode: 0o600 });
        await chmod(settingsFile, 0o600);

        return spawnBounded({
          exe,
          args: geminiArgs(),
          cwd: work,
          env: childEnvironment(env, {
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile,
            GEMINI_SYSTEM_MD: systemFile,
          }),
          stdin: prompt,
          deadline,
          signal,
          parse: (out) => parseGeminiOutput(out),
        });
      });
    },
  };
}

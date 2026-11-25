// Adapter for the OpenAI Codex CLI (`codex`), already logged in on this computer.
//
// SAFETY (owner rule, 2026-11-15; guard: safety.guard.test.ts):
//   - Starts in a fresh empty working directory (`cwd: work`), removed on exit.
//   - Runs with a fresh private `CODEX_HOME` (0700) containing ONLY a copy of the user's `auth.json` (if present, 0600)
//     plus a generated `config.toml` (0600) — the user's personal `config.toml`, MCP servers, hooks and skills never load.
//   - Locks `sandbox_mode = "read-only"`, `approval_policy = "never"`, `web_search = "disabled"`,
//     `[features] shell_tool = false`, `--sandbox read-only`, `--ephemeral`, `--skip-git-repo-check`.
//   - Connects ONLY to Onden's MCP server (`[mcp_servers.onden]`); the per-session key lives only inside the 0600 config.toml,
//     never in CLI arguments or environment variables.
//   - Prompt is sent on stdin (`-`), never in CLI arguments; system prompt lives in a 0600 `model_instructions_file`.
// Note: verified against Codex CLI's documented `codex exec` + `config.toml` contract; verify again on a real install
// after major Codex CLI upgrades.
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { childEnvironment, resolveExecutable, runToEnd, spawnBounded, withIsolatedRunDir } from "./runtime.mjs";

/** The flags that keep Codex CLI harmless; `codexArgs` always includes all of them. */
export const CODEX_SAFETY_FLAGS = Object.freeze({
  nonInteractive: ["exec"],
  jsonOutput: ["--json"],
  nothingKept: ["--ephemeral"],
  readOnlySandbox: ["--sandbox", "read-only"],
  noGitNeeded: ["--skip-git-repo-check"],
  promptFromStdin: ["-"],
});

export function codexArgs() {
  return [
    ...CODEX_SAFETY_FLAGS.nonInteractive,
    ...CODEX_SAFETY_FLAGS.jsonOutput,
    ...CODEX_SAFETY_FLAGS.nothingKept,
    ...CODEX_SAFETY_FLAGS.readOnlySandbox,
    ...CODEX_SAFETY_FLAGS.noGitNeeded,
    ...CODEX_SAFETY_FLAGS.promptFromStdin,
  ];
}

/** Generate the isolated per-session `config.toml`. Session key lives only inside this 0600 file.
 * @param {{ mcpUrl: string, sessionKey: string, instructionsFile: string }} input
 */
export function codexConfigToml({ mcpUrl, sessionKey, instructionsFile }) {
  const q = (/** @type {string} */ s) => JSON.stringify(s);
  return [
    `sandbox_mode = "read-only"`,
    `approval_policy = "never"`,
    `web_search = "disabled"`,
    `model_instructions_file = ${q(instructionsFile)}`,
    ``,
    `[features]`,
    `shell_tool = false`,
    `web_search_request = false`,
    ``,
    `[mcp_servers.onden]`,
    `url = ${q(mcpUrl)}`,
    `http_headers = { Authorization = ${q(`Bearer ${sessionKey}`)} }`,
    `required = true`,
    ``,
  ].join("\n");
}

/**
 * Parse `codex exec --json` JSONL output: pick the final `item.completed` `agent_message` text.
 * @param {string} stdout
 * @returns {{ ok: true, text: string } | { ok: false, reason: "empty" | "not_json" | "tool_error" }}
 */
export function parseCodexOutput(stdout) {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: "empty" };
  let parsedAny = false;
  let sawError = false;
  let lastText = "";
  for (const line of lines) {
    /** @type {any} */
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    parsedAny = true;
    if (ev.type === "error" || ev.type === "turn.failed" || ev.is_error === true) sawError = true;
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
      const candidate = typeof ev.item.text === "string"
        ? ev.item.text
        : Array.isArray(ev.item.content)
          ? ev.item.content.map((/** @type {any} */ p) => (typeof p?.text === "string" ? p.text : "")).join("")
          : "";
      if (candidate.trim()) lastText = candidate.trim();
    } else if (typeof ev.result === "string" && ev.result.trim()) {
      lastText = ev.result.trim();
    }
  }
  if (!parsedAny) return { ok: false, reason: "not_json" };
  if (sawError && !lastText) return { ok: false, reason: "tool_error" };
  return lastText ? { ok: true, text: lastText } : { ok: false, reason: "empty" };
}

/** Copy only `auth.json` from the user's real CODEX_HOME (never their config, hooks or skills).
 * @param {NodeJS.ProcessEnv} env @param {string} isolatedHome
 */
async function copyAuthJsonIfPresent(env, isolatedHome) {
  const sourceHome = env.CODEX_HOME || join(homedir(), ".codex");
  const src = join(sourceHome, "auth.json");
  const dst = join(isolatedHome, "auth.json");
  try {
    await copyFile(src, dst);
    await chmod(dst, 0o600);
  } catch { /* keyring auth or tests without auth.json */ }
}

/**
 * @param {{ command?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {import("./index.mjs").Adapter}
 */
export function createCodexAdapter({ command = "codex", env = process.env } = {}) {
  return {
    id: "codex",
    label: "Codex CLI",
    async detect() {
      const found = await resolveExecutable(command, env);
      const version = found ? await runToEnd(found, ["--version"], { env }) : { code: null, out: "", err: "", error: new Error("missing") };
      if (!found || version.error || version.code !== 0 || !/\d+\.\d+\.\d+/.test(`${version.out}\n${version.err}`)) {
        return { ok: false, reason: "missing", message: `在這台電腦上找不到命令列 AI 工具（${command}）。請先安裝它並登入，再重新開始。` };
      }
      const auth = await runToEnd(found, ["login", "status"], { env });
      if (auth.error === null && auth.code !== 0 && /not logged in|login|sign in|unauthenticated/i.test(`${auth.out}\n${auth.err}`)) {
        return { ok: false, reason: "not_logged_in", message: "命令列 AI 工具還沒登入。請在終端機執行它並完成登入，再重新開始。" };
      }
      return { ok: true, command: found };
    },
    async run({ system, prompt, mcpUrl, sessionKey, deadline, signal }) {
      const exe = await resolveExecutable(command, env);
      if (!exe) return { ok: false, reason: "not_started" };
      return withIsolatedRunDir(async ({ work, configDir }) => {
        const codexHome = join(configDir, "codex-home");
        await mkdir(codexHome, { mode: 0o700 });
        await copyAuthJsonIfPresent(env, codexHome);
        const instructionsFile = join(configDir, "system.md");
        await writeFile(instructionsFile, system, { mode: 0o600 });
        await chmod(instructionsFile, 0o600);
        const configFile = join(codexHome, "config.toml");
        await writeFile(configFile, codexConfigToml({ mcpUrl, sessionKey, instructionsFile }), { mode: 0o600 });
        await chmod(configFile, 0o600);

        return spawnBounded({
          exe,
          args: codexArgs(),
          cwd: work,
          env: childEnvironment(env, { CODEX_HOME: codexHome }),
          stdin: prompt,
          deadline,
          signal,
          parse: (out) => parseCodexOutput(out),
        });
      });
    },
  };
}

// Adapter for the GitHub Copilot CLI (`copilot`), already logged in on this computer.
//
// SAFETY (owner rule, 2026-11-15; guard: safety.guard.test.ts):
//   - Starts in a fresh empty working directory (`cwd: work`), removed on exit.
//   - Denies every built-in file, shell, search and network tool via `--deny-tool=...`.
//   - Disables built-in MCP servers (`--disable-builtin-mcps`), custom instructions (`--no-custom-instructions`),
//     and self-update (`--no-auto-update`).
//   - Communicates via ACP (`--acp`, JSON-RPC 2.0 over stdio): advertises zero client capabilities, passes
//     ONLY Onden's MCP server + per-session key over stdin (never in argv, env, or disk), and fail-closed
//     rejects any `session/request_permission` that does not target Onden's MCP server.
//   - `detect()` closes stdin and requires a semver version so bootstrapper shims (e.g. VS Code's interactive
//     `/usr/bin/copilot` installer prompt) never hang or falsely report installed.
import { createWarmAcpRunner, runAcpSession } from "./acp.mjs";
import { childEnvironment, resolveExecutable, runToEnd, withIsolatedRunDir } from "./runtime.mjs";

export const COPILOT_DENIED_TOOLS = Object.freeze([
  "shell",
  "powershell",
  "write",
  "edit",
  "create",
  "view",
  "glob",
  "grep",
  "task",
  "web_fetch",
]);

/** The flags that keep Copilot CLI harmless; `copilotArgs` always includes all of them. */
export const COPILOT_SAFETY_FLAGS = Object.freeze({
  acpMode: ["--acp"],
  noBuiltInTools: COPILOT_DENIED_TOOLS.map((t) => `--deny-tool=${t}`),
  noBuiltInMcps: ["--disable-builtin-mcps"],
  noCustomInstructions: ["--no-custom-instructions"],
  noAutoUpdate: ["--no-auto-update"],
});

export function copilotArgs() {
  return [
    ...COPILOT_SAFETY_FLAGS.acpMode,
    ...COPILOT_SAFETY_FLAGS.noBuiltInTools,
    ...COPILOT_SAFETY_FLAGS.noBuiltInMcps,
    ...COPILOT_SAFETY_FLAGS.noCustomInstructions,
    ...COPILOT_SAFETY_FLAGS.noAutoUpdate,
  ];
}

/**
 * @param {{ command?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {import("./index.mjs").Adapter}
 */
export function createCopilotAdapter({ command = "copilot", env = process.env } = {}) {
  const warm = createWarmAcpRunner();
  return {
    id: "copilot",
    label: "GitHub Copilot CLI",
    async detect() {
      const found = await resolveExecutable(command, env);
      const version = found ? await runToEnd(found, ["--version"], { env }) : { code: null, out: "", err: "", error: new Error("missing") };
      // Bootstrapper shims exit 0 without printing a semver version when stdin is closed: require an actual version.
      if (!found || version.error || version.code !== 0 || !/\d+\.\d+\.\d+/.test(`${version.out}\n${version.err}`)) {
        return { ok: false, reason: "missing", message: `在這台電腦上找不到命令列 AI 工具（${command}）。請先安裝它並登入，再重新開始。` };
      }
      return { ok: true, command: found };
    },
    async run({ system, prompt, mcpUrl, sessionKey, deadline, signal, threadKey, messages, onProgress }) {
      const exe = await resolveExecutable(command, env);
      if (!exe) return { ok: false, reason: "not_started" };
      if (threadKey) {
        return warm.run({
          exe,
          args: copilotArgs(),
          env: childEnvironment(env),
          system,
          prompt,
          mcpUrl,
          sessionKey,
          deadline,
          signal,
          threadKey,
          messages,
          onProgress,
        });
      }
      return withIsolatedRunDir(({ work }) => runAcpSession({
        exe,
        args: copilotArgs(),
        cwd: work,
        env: childEnvironment(env),
        system,
        prompt,
        mcpUrl,
        sessionKey,
        deadline,
        signal,
        onProgress,
      }));
    },
    dispose: () => warm.dispose(),
  };
}

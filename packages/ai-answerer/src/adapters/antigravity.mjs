// Adapter for Google Antigravity (`agy acp` or standalone `agy_acp_server`), already logged in on this computer.
//
// SAFETY (owner rule, 2026-11-15; guard: safety.guard.test.ts):
//   - Starts in a fresh empty working directory (`cwd: work`), removed on exit.
//   - For `agy`, launches `agy acp --sandbox --include-default-customizations=false --disable-telemetry`
//     (checked against real `agy` 1.5.16, 2026-11-25).
//   - Communicates via ACP (JSON-RPC 2.0 over stdio): advertises zero client capabilities (`clientCapabilities: {}`),
//     passes ONLY Onden's MCP server + per-session key over stdin in `session/new` (never in argv, env, or disk),
//     and fail-closed rejects every `session/request_permission` call that does not target Onden's MCP server.
//   - Strips ONDEN_* from the child environment and never uses a shell.
import { basename } from "node:path";
import { createWarmAcpRunner, runAcpSession } from "./acp.mjs";
import { childEnvironment, resolveFirstExecutable, runToEnd, withIsolatedRunDir } from "./runtime.mjs";

const DEFAULT_COMMANDS = Object.freeze(
  process.platform === "win32"
    ? ["agy", "agy_acp_server.exe", "agy_acp_server"]
    : ["agy", "agy_acp_server.par", "agy_acp_server"],
);

/** Whether `command` points at the standalone ACP server binary (`agy_acp_server*`) rather than the `agy` CLI.
 * @param {string} command
 */
export function isStandaloneAcpBinary(command) {
  return /^agy_acp_server(?:\.par|\.exe)?$/i.test(basename(command));
}

/** The guarantees enforced by Antigravity's ACP launch; guarded by `safety.guard.test.ts`. */
export const ANTIGRAVITY_SAFETY_FLAGS = Object.freeze({
  acpSubcommand: ["acp"],
  sandbox: ["--sandbox"],
  noDefaultCustomizations: ["--include-default-customizations=false"],
  noTelemetry: ["--disable-telemetry"],
  standaloneArgs: [],
  clientCapabilities: Object.freeze({}),
  onlyOurMcpServer: "onden",
});

/** Launch args for the resolved Antigravity executable. @param {string} executable */
export function antigravityArgs(executable) {
  if (isStandaloneAcpBinary(executable)) return [...ANTIGRAVITY_SAFETY_FLAGS.standaloneArgs];
  return [
    ...ANTIGRAVITY_SAFETY_FLAGS.acpSubcommand,
    ...ANTIGRAVITY_SAFETY_FLAGS.sandbox,
    ...ANTIGRAVITY_SAFETY_FLAGS.noDefaultCustomizations,
    ...ANTIGRAVITY_SAFETY_FLAGS.noTelemetry,
  ];
}

/** Probe args for `--version`: standalone `.par`/`.exe` builds accept `--undefok=version --version --only_check_args`.
 * @param {string} executable
 */
function probeArgs(executable) {
  return isStandaloneAcpBinary(executable) ? ["--undefok=version", "--version", "--only_check_args"] : ["--version"];
}

/**
 * @param {{ command?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {import("./index.mjs").Adapter}
 */
export function createAntigravityAdapter({ command, env = process.env } = {}) {
  const candidates = command ? [command] : DEFAULT_COMMANDS;
  const warm = createWarmAcpRunner();
  return {
    id: "antigravity",
    label: "Antigravity",
    async detect() {
      const found = await resolveFirstExecutable(candidates, env);
      if (!found) {
        return { ok: false, reason: "missing", message: `在這台電腦上找不到命令列 AI 工具（${command ?? "agy"}）。請先安裝它並登入，再重新開始。` };
      }
      const version = await runToEnd(found, probeArgs(found), { env });
      if (version.error || version.code !== 0) {
        return { ok: false, reason: "missing", message: `在這台電腦上找不到命令列 AI 工具（${command ?? "agy"}）。請先安裝它並登入，再重新開始。` };
      }
      return { ok: true, command: found };
    },
    async run({ system, prompt, mcpUrl, sessionKey, deadline, signal, threadKey, messages, onProgress }) {
      const exe = await resolveFirstExecutable(candidates, env);
      if (!exe) return { ok: false, reason: "not_started" };
      if (threadKey) {
        return warm.run({
          exe,
          args: antigravityArgs(exe),
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
        args: antigravityArgs(exe),
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

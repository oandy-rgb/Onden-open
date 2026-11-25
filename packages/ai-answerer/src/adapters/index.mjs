// The AI tools this program can drive: a plain list, not a plugin system. Adding a tool = one file here
// and one line below, with its own safety test.
import { basename } from "node:path";
import { createAntigravityAdapter } from "./antigravity.mjs";
import { createClaudeCodeAdapter } from "./claudeCode.mjs";
import { createCodexAdapter } from "./codex.mjs";
import { createCopilotAdapter } from "./copilot.mjs";
import { createGeminiAdapter } from "./gemini.mjs";

/**
 * @typedef {{ ok: true, text: string } | { ok: false, reason: "empty" | "not_json" | "tool_error" | "timeout" | "cancelled" | "not_started" | "too_long" }} RunResult
 * @typedef {{ ok: true, command: string } | { ok: false, reason: "missing" | "not_logged_in", message: string }} DetectResult
 * @typedef {{ kind: "action" | "message", tool?: string, text?: string }} ProgressEvent
 * @typedef {{
 *   id: string, label: string,
 *   detect(): Promise<DetectResult>,
 *   run(input: {
 *     system: string, prompt: string, mcpUrl: string, sessionKey: string, deadline: number, signal?: AbortSignal,
 *     threadKey?: string, messages?: Array<{ role: string, content: string }>,
 *     onProgress?: (event: ProgressEvent) => void,
 *   }): Promise<RunResult>,
 *   dispose?: () => Promise<void> | void,
 * }} Adapter
 */

export const ADAPTER_IDS = Object.freeze(["claude-code", "codex", "gemini", "antigravity", "copilot"]);

/** @typedef {(typeof ADAPTER_IDS)[number]} AdapterId */

/** Infer an adapter id from an explicit executable name/path; unknown names default to `claude-code`
 * so existing callers passing a custom wrapper or test stand-in keep working.
 * @param {string} command
 * @returns {AdapterId}
 */
export function inferAdapterId(command) {
  const name = basename(command).toLowerCase();
  if (/^codex(?:\.exe|\.cmd)?$/.test(name)) return "codex";
  if (/^gemini(?:\.exe|\.cmd)?$/.test(name)) return "gemini";
  if (/^(?:agy|agy_acp_server(?:\.par|\.exe)?|antigravity(?:\.exe)?)$/.test(name)) return "antigravity";
  if (/^copilot(?:\.exe|\.cmd)?$/.test(name)) return "copilot";
  return "claude-code";
}

/**
 * Build the ordered list of adapters. When `command` is supplied without `tool`, it is applied to the
 * inferred adapter (defaulting to `claude-code`, keeping `createAdapters({ command })[0]` compatible).
 * @param {{ tool?: string, command?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Adapter[]}
 */
export function createAdapters({ tool, command, env } = {}) {
  const target = tool ?? (command ? inferAdapterId(command) : undefined);
  /** @param {AdapterId} id */
  const opts = (id) => ({ ...(target === id && command ? { command } : {}), ...(env ? { env } : {}) });
  return [
    createClaudeCodeAdapter(opts("claude-code")),
    createCodexAdapter(opts("codex")),
    createGeminiAdapter(opts("gemini")),
    createAntigravityAdapter(opts("antigravity")),
    createCopilotAdapter(opts("copilot")),
  ];
}

/**
 * Find the adapter to use on this computer:
 *   - Explicit `tool` (`--tool`): probe only that adapter (unknown ids fail with `missing`).
 *   - Explicit `command` (`--tool-command`) without `tool`: probe the adapter inferred from the executable name.
 *   - Neither: probe all built-in adapters in order and return the first ready one (preferring `not_logged_in`
 *     over `missing` if an installed tool was found that has not signed in yet).
 * @param {{ tool?: string, command?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ ok: true, adapter: Adapter, command: string } | { ok: false, reason: "missing" | "not_logged_in", message: string }>}
 */
export async function detectAdapter({ tool, command, env } = {}) {
  const all = createAdapters({ tool, command, env });
  if (tool) {
    const picked = all.find((a) => a.id === tool);
    if (!picked) {
      return { ok: false, reason: "missing", message: `不認得的 AI 工具名稱（${tool}）。支援：${ADAPTER_IDS.join("、")}。` };
    }
    const result = await picked.detect();
    return result.ok ? { ok: true, adapter: picked, command: result.command } : result;
  }
  if (command) {
    const picked = all.find((a) => a.id === inferAdapterId(command)) ?? all[0];
    const result = await picked.detect();
    return result.ok ? { ok: true, adapter: picked, command: result.command } : result;
  }

  /** @type {{ ok: false, reason: "not_logged_in", message: string } | null} */
  let notLoggedIn = null;
  for (const adapter of all) {
    const result = await adapter.detect();
    if (result.ok) return { ok: true, adapter, command: result.command };
    if (result.reason === "not_logged_in" && !notLoggedIn) {
      notLoggedIn = { ok: false, reason: "not_logged_in", message: result.message };
    }
  }
  if (notLoggedIn) return notLoggedIn;
  return {
    ok: false,
    reason: "missing",
    message: `在這台電腦上找不到支援的命令列 AI 工具（${ADAPTER_IDS.join(" / ")}）。請先安裝其中一個並登入，再重新開始。`,
  };
}

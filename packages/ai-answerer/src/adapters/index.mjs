// The AI tools this program can drive: a plain list, not a plugin system. Adding a tool = one file here
// and one line below, with its own safety test.
import { createClaudeCodeAdapter } from "./claudeCode.mjs";

/**
 * @typedef {{ ok: true, text: string } | { ok: false, reason: "empty" | "not_json" | "tool_error" | "timeout" | "cancelled" | "not_started" | "too_long" }} RunResult
 * @typedef {{
 *   id: string, label: string,
 *   detect(): Promise<{ ok: true, command: string } | { ok: false, reason: "missing" | "not_logged_in", message: string }>,
 *   run(input: { system: string, prompt: string, mcpUrl: string, sessionKey: string, deadline: number, signal?: AbortSignal }): Promise<RunResult>,
 * }} Adapter
 */

/** @param {{ command?: string, env?: NodeJS.ProcessEnv }} [options] @returns {Adapter[]} */
export const createAdapters = (options) => [createClaudeCodeAdapter(options)];

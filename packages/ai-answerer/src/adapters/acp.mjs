// Minimal, dependency-free Agent Client Protocol (ACP) client over stdio (newline-delimited JSON-RPC 2.0).
// Supports both one-shot (`runAcpSession`) and warm-pooled (`createWarmAcpRunner`) execution for ACP CLIs
// (Copilot CLI `--acp`, Antigravity `agy acp` / `agy_acp_server`).
//
// SAFETY:
//   - Advertises empty `clientCapabilities: {}` (no client filesystem or terminal access).
//   - Passes ONLY Onden's MCP server in `session/new` over stdin (session key never enters argv, env, or disk).
//   - Warm runner routes MCP calls through an ephemeral 127.0.0.1 auth proxy whose Bearer token is set only
//     for the active turn and cleared immediately in `finally`.
//   - Warm session reuse is STRICT: same `threadKey` (space + note + agent + initiator + system) AND the
//     previous turn's assistant answer matches `messages.at(-2)`; otherwise `session/close` + fresh `session/new`.
//   - Fail-closed `session/request_permission` handler: ONLY allows tool calls unmistakably targeting Onden's
//     MCP server (`mcpServerName`); every built-in file, shell, edit, web or unknown tool call is rejected.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createMcpAuthProxy } from "./mcpProxy.mjs";
import { killProcessGroup, MAX_OUTPUT_BYTES } from "./runtime.mjs";

export const ACP_PROTOCOL_VERSION = 1;
export const ONDEN_MCP_SERVER_NAME = "onden";
const DEFAULT_WARM_IDLE_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Determine whether an ACP `session/request_permission` request targets ONLY Onden's MCP server.
 * Fail-closed: if the server cannot be positively identified as `mcpServerName`, returns false.
 * @param {any} params
 * @param {string} [mcpServerName]
 * @returns {boolean}
 */
export function isOndenMcpPermissionRequest(params, mcpServerName = ONDEN_MCP_SERVER_NAME) {
  const toolCall = params?.toolCall;
  if (!toolCall || typeof toolCall !== "object") return false;

  const meta = toolCall._meta;
  if (meta && typeof meta === "object") {
    if (meta.is_mcp_tool_call === true) {
      const server = meta.mcp?.server ?? toolCall.rawInput?.server;
      return server === mcpServerName;
    }
    if (typeof meta.mcp?.server === "string") {
      return meta.mcp.server === mcpServerName;
    }
  }

  if (typeof toolCall.rawInput?.server === "string") {
    return toolCall.rawInput.server === mcpServerName;
  }

  // Antigravity (`mcp_onden_<tool>`), Claude/Copilot (`mcp__onden__<tool>`, `onden/<tool>`, etc.)
  const name = typeof toolCall.name === "string" ? toolCall.name : typeof toolCall.title === "string" ? toolCall.title : "";
  if (
    name.startsWith(`mcp__${mcpServerName}__`) ||
    name.startsWith(`mcp_${mcpServerName}_`) ||
    name.startsWith(`${mcpServerName}__`) ||
    name.startsWith(`${mcpServerName}/`) ||
    name.startsWith(`${mcpServerName}:`) ||
    name.startsWith(`${mcpServerName}-`) ||
    name.startsWith(`mcp.${mcpServerName}.`)
  ) {
    return true;
  }
  return false;
}

/** Extract the clean Onden tool name (e.g. `getNode`, `searchNodes`) from an ACP tool_call update, or null.
 * @param {any} update @param {string} [mcpServerName] @returns {string | null}
 */
export function extractOndenToolName(update, mcpServerName = ONDEN_MCP_SERVER_NAME) {
  if (!update || typeof update !== "object") return null;
  const metaTool = update._meta?.mcp?.tool;
  if (typeof metaTool === "string" && update._meta?.mcp?.server === mcpServerName) return metaTool;
  const raw = typeof update.name === "string" ? update.name : typeof update.title === "string" ? update.title : "";
  for (const prefix of [
    `mcp__${mcpServerName}__`,
    `mcp_${mcpServerName}_`,
    `${mcpServerName}__`,
    `${mcpServerName}/`,
    `${mcpServerName}:`,
    `${mcpServerName}-`,
    `mcp.${mcpServerName}.`,
  ]) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length) || null;
  }
  return null;
}

/**
 * Answer an ACP `session/request_permission` request: allow ONLY Onden's MCP server; deny everything else.
 * @param {any} params
 * @param {string} [mcpServerName]
 */
export function decideAcpPermission(params, mcpServerName = ONDEN_MCP_SERVER_NAME) {
  const options = Array.isArray(params?.options) ? params.options : [];
  if (isOndenMcpPermissionRequest(params, mcpServerName)) {
    const allow = options.find((/** @type {any} */ o) => o?.kind === "allow_once")
      ?? options.find((/** @type {any} */ o) => o?.kind === "allow_always");
    if (allow && typeof allow.optionId === "string") {
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
  }
  const reject = options.find((/** @type {any} */ o) => o?.kind === "reject_always")
    ?? options.find((/** @type {any} */ o) => o?.kind === "reject_once");
  if (reject && typeof reject.optionId === "string") {
    return { outcome: { outcome: "selected", optionId: reject.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** Combine system instructions and user prompt for ACP (which carries no separate system-prompt field).
 * @param {string} system @param {string} prompt
 */
export function composeAcpPrompt(system, prompt) {
  return system ? `<system_instructions>\n${system}\n</system_instructions>\n\n${prompt}` : prompt;
}

/** Build the single-server MCP config passed in ACP `session/new`.
 * @param {string} mcpUrl @param {string} [sessionKey]
 */
export function acpMcpServers(mcpUrl, sessionKey) {
  return [{
    name: ONDEN_MCP_SERVER_NAME,
    type: "http",
    url: mcpUrl,
    headers: sessionKey ? [{ name: "Authorization", value: `Bearer ${sessionKey}` }] : [],
  }];
}

/** Extract text from an ACP `agent_message_chunk` update content payload.
 * @param {any} content
 */
function extractUpdateText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.content && typeof content.content.text === "string") return content.content.text;
  return "";
}

/**
 * Decide whether a warm ACP session can be safely reused for the next turn of the same conversation.
 * Strict conditions: identical `threadKey` (space + note + agent + initiator + system), at least one
 * prior Q/A pair (`messages.length >= 3`), latest message is `user`, and the immediately preceding
 * `assistant` message matches the exact answer produced by the previous turn of this warm session.
 * @param {{ sessionId: string, threadKey: string, lastAnswer: string } | null} prev
 * @param {{ threadKey?: string, messages?: Array<{ role: string, content: string }> }} next
 */
export function canReuseWarmSession(prev, next) {
  if (!prev || !next.threadKey || prev.threadKey !== next.threadKey) return false;
  const msgs = next.messages;
  if (!Array.isArray(msgs) || msgs.length < 3) return false;
  const last = msgs[msgs.length - 1];
  const prevAssistant = msgs[msgs.length - 2];
  return last?.role === "user" && prevAssistant?.role === "assistant" && prevAssistant.content.trim() === prev.lastAnswer;
}

/**
 * Open a low-level ACP JSON-RPC stdio transport to one subprocess.
 * @param {{ exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv }} spec
 */
function openAcpTransport({ exe, args, cwd, env }) {
  const child = spawn(exe, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
    detached: process.platform !== "win32",
  });
  let nextId = 1;
  let closed = false;
  let sawValidJson = false;
  let spawnError = false;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void }>} */
  const pending = new Map();
  /** @type {((method: string, params: any) => void) | null} */
  let onNotification = null;

  const rl = createInterface({ input: child.stdout });

  /** @param {Record<string, unknown>} msg */
  const send = (msg) => {
    if (closed || child.stdin.destroyed || !child.stdin.writable) return;
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`); } catch { /* ignore */ }
  };

  /** @param {string} reason */
  const failAll = (reason) => {
    for (const wait of pending.values()) wait.reject(new Error(reason));
    pending.clear();
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    sawValidJson = true;

    if (typeof msg.id === "number" && !msg.method) {
      const wait = pending.get(msg.id);
      if (!wait) return;
      pending.delete(msg.id);
      if (msg.error) wait.reject(new Error(String(msg.error.message || "acp_error")));
      else wait.resolve(msg.result);
      return;
    }

    if (msg.id !== undefined && typeof msg.method === "string") {
      if (msg.method === "session/request_permission") {
        send({ id: msg.id, result: decideAcpPermission(msg.params, ONDEN_MCP_SERVER_NAME) });
      } else {
        send({ id: msg.id, error: { code: -32601, message: `Unsupported method: ${msg.method}` } });
      }
      return;
    }

    if (typeof msg.method === "string") onNotification?.(msg.method, msg.params);
  });

  child.stdin.on("error", () => {});
  child.on("error", () => { spawnError = true; closed = true; rl.close(); failAll("not_started"); });
  child.on("close", () => { closed = true; rl.close(); failAll(sawValidJson ? "tool_error" : "not_json"); });

  return {
    isAlive: () => !closed,
    sawJson: () => sawValidJson,
    hadSpawnError: () => spawnError,
    /** @param {((method: string, params: any) => void) | null} fn */
    setNotificationHandler(fn) { onNotification = fn; },
    /** @param {string} method @param {unknown} params */
    notify(method, params) { send({ method, params }); },
    /** @param {string} method @param {unknown} params @param {number} [timeoutMs] */
    request(method, params, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error(spawnError ? "not_started" : sawValidJson ? "tool_error" : "not_json")); return; }
        const id = nextId++;
        /** @type {ReturnType<typeof setTimeout> | null} */
        let timer = null;
        const done = (/** @type {() => void} */ fn) => {
          if (timer) clearTimeout(timer);
          pending.delete(id);
          fn();
        };
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => done(() => reject(new Error("timeout"))), Math.max(0, timeoutMs));
        }
        pending.set(id, {
          resolve: (v) => done(() => resolve(v)),
          reject: (e) => done(() => reject(e)),
        });
        send({ id, method, params });
      });
    },
    destroy() {
      if (!closed) {
        closed = true;
        rl.close();
        failAll("closed");
        killProcessGroup(child);
      }
    },
  };
}

/**
 * Create a warm ACP runner for one adapter: keeps a single initialized ACP subprocess, empty 0700
 * working dir, and ephemeral loopback MCP auth proxy warm across turns (reaping after `idleMs`).
 * Strictly reuses an ACP `sessionId` ONLY for consecutive turns of the exact same conversation.
 * @param {{ idleMs?: number }} [options]
 */
export function createWarmAcpRunner({ idleMs = DEFAULT_WARM_IDLE_MS } = {}) {
  /** @type {{
   *   exe: string, argsKey: string, root: string, work: string,
   *   transport: ReturnType<typeof openAcpTransport>,
   *   proxy: Awaited<ReturnType<typeof createMcpAuthProxy>>,
   *   lastSession: { sessionId: string, threadKey: string, lastAnswer: string } | null,
   * } | null} */
  let state = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null;

  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => { void dispose(); }, idleMs);
    idleTimer.unref?.();
  };

  async function dispose() {
    clearIdle();
    const cur = state;
    state = null;
    if (!cur) return;
    cur.transport.destroy();
    await cur.proxy.close().catch(() => {});
    await rm(cur.root, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Ensure a live, initialized ACP process + proxy exists for `(exe, args)`.
   * @param {{ exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number }} spec
   */
  async function ensureWarm({ exe, args, env, timeoutMs }) {
    const argsKey = JSON.stringify(args);
    if (state && state.exe === exe && state.argsKey === argsKey && state.transport.isAlive()) {
      return state;
    }
    await dispose();
    const root = await mkdtemp(join(tmpdir(), "onden-ai-"));
    try {
      await chmod(root, 0o700);
      const work = join(root, "work");
      await mkdir(work, { mode: 0o700 });
      const proxy = await createMcpAuthProxy();
      const transport = openAcpTransport({ exe, args, cwd: work, env });
      try {
        await transport.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "onden-ai-answerer", version: "0.1.0" },
        }, Math.min(timeoutMs, HANDSHAKE_TIMEOUT_MS));
      } catch (err) {
        transport.destroy();
        await proxy.close().catch(() => {});
        throw err;
      }
      state = { exe, argsKey, root, work, transport, proxy, lastSession: null };
      return state;
    } catch (err) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Execute one turn on the warm ACP process (reusing the ACP session if the same conversation continues).
   * @param {{
   *   exe: string, args: string[], env: NodeJS.ProcessEnv,
   *   system: string, prompt: string, mcpUrl: string, sessionKey: string,
   *   deadline: number, signal?: AbortSignal,
   *   threadKey?: string, messages?: Array<{ role: string, content: string }>,
   *   onProgress?: (event: { kind: "action" | "message", tool?: string, text?: string }) => void,
   * }} input
   * @returns {Promise<import("./index.mjs").RunResult>}
   */
  async function run(input) {
    clearIdle();
    const remaining = () => Math.max(0, input.deadline - Date.now());
    if (input.signal?.aborted) return { ok: false, reason: "cancelled" };
    if (remaining() <= 0) return { ok: false, reason: "timeout" };

    /** @type {NonNullable<typeof state>} */
    let warm;
    try {
      warm = await ensureWarm({ exe: input.exe, args: input.args, env: input.env, timeoutMs: remaining() });
    } catch (err) {
      const code = err instanceof Error ? err.message : "tool_error";
      if (code === "not_started") return { ok: false, reason: "not_started" };
      if (code === "timeout") return { ok: false, reason: "timeout" };
      if (code === "not_json") return { ok: false, reason: "not_json" };
      return { ok: false, reason: "tool_error" };
    }

    warm.proxy.setTarget(input.mcpUrl, input.sessionKey);
    let activeSessionId = "";
    let chunks = "";
    let tooLong = false;
    let cancelled = false;
    let timedOut = false;

    const onAbort = () => {
      cancelled = true;
      if (activeSessionId) warm.transport.notify("session/cancel", { sessionId: activeSessionId });
      void dispose();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (activeSessionId) warm.transport.notify("session/cancel", { sessionId: activeSessionId });
      void dispose();
    }, remaining());

    input.signal?.addEventListener("abort", onAbort, { once: true });
    warm.transport.setNotificationHandler((method, params) => {
      if (method !== "session/update") return;
      const update = params?.update;
      const sid = params?.sessionId;
      if (!update || (activeSessionId && sid && sid !== activeSessionId)) return;
      if (update.sessionUpdate === "tool_call") {
        const tool = extractOndenToolName(update, ONDEN_MCP_SERVER_NAME);
        if (tool) input.onProgress?.({ kind: "action", tool });
      } else if (update.sessionUpdate === "agent_message_chunk") {
        const text = extractUpdateText(update.content);
        if (text) {
          chunks += text;
          if (chunks.length > MAX_OUTPUT_BYTES) {
            tooLong = true;
            void dispose();
          } else {
            input.onProgress?.({ kind: "message", text });
          }
        }
      }
    });

    try {
      const reuse = canReuseWarmSession(warm.lastSession, { threadKey: input.threadKey, messages: input.messages });
      let promptText;
      if (reuse && warm.lastSession && input.messages && input.messages.length > 0) {
        activeSessionId = warm.lastSession.sessionId;
        promptText = input.messages[input.messages.length - 1].content;
      } else {
        if (warm.lastSession) {
          const oldId = warm.lastSession.sessionId;
          warm.lastSession = null;
          warm.transport.notify("session/close", { sessionId: oldId });
        }
        const created = await warm.transport.request("session/new", {
          cwd: warm.work,
          mcpServers: acpMcpServers(warm.proxy.url),
        }, remaining());
        activeSessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
        if (!activeSessionId) return { ok: false, reason: "tool_error" };
        promptText = composeAcpPrompt(input.system, input.prompt);
      }

      const promptResult = await warm.transport.request("session/prompt", {
        sessionId: activeSessionId,
        prompt: [{ type: "text", text: promptText }],
      }, remaining());

      if (tooLong) return { ok: false, reason: "too_long" };
      if (cancelled) return { ok: false, reason: "cancelled" };
      if (timedOut) return { ok: false, reason: "timeout" };

      const fallback = typeof promptResult?.text === "string" ? promptResult.text : "";
      const text = (chunks || fallback).trim();
      if (!text) {
        warm.lastSession = null;
        return { ok: false, reason: "empty" };
      }

      if (input.threadKey) {
        warm.lastSession = { sessionId: activeSessionId, threadKey: input.threadKey, lastAnswer: text };
      } else {
        warm.lastSession = null;
        warm.transport.notify("session/close", { sessionId: activeSessionId });
      }
      return { ok: true, text };
    } catch {
      if (warm) warm.lastSession = null;
      if (tooLong) return { ok: false, reason: "too_long" };
      if (cancelled) return { ok: false, reason: "cancelled" };
      if (timedOut) return { ok: false, reason: "timeout" };
      const sawJson = warm.transport.sawJson();
      await dispose();
      return { ok: false, reason: sawJson ? "tool_error" : "not_json" };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      warm.transport.setNotificationHandler(null);
      warm.proxy.clearTarget();
      if (state) armIdle();
    }
  }

  return { run, dispose };
}

/**
 * Run a single sealed one-shot ACP session (spawns and destroys immediately).
 * @param {{
 *   exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
 *   system: string, prompt: string, mcpUrl: string, sessionKey: string,
 *   deadline: number, signal?: AbortSignal,
 *   onProgress?: (event: { kind: "action" | "message", tool?: string, text?: string }) => void,
 * }} input
 * @returns {Promise<import("./index.mjs").RunResult>}
 */
export async function runAcpSession({ exe, args, cwd, env, system, prompt, mcpUrl, sessionKey, deadline, signal, onProgress }) {
  const remaining = () => Math.max(0, deadline - Date.now());
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  if (remaining() <= 0) return { ok: false, reason: "timeout" };

  const transport = openAcpTransport({ exe, args, cwd, env });
  let activeSessionId = "";
  let chunks = "";
  let tooLong = false;
  let cancelled = false;
  let timedOut = false;

  const onAbort = () => {
    cancelled = true;
    if (activeSessionId) transport.notify("session/cancel", { sessionId: activeSessionId });
    transport.destroy();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    if (activeSessionId) transport.notify("session/cancel", { sessionId: activeSessionId });
    transport.destroy();
  }, remaining());

  signal?.addEventListener("abort", onAbort, { once: true });
  transport.setNotificationHandler((method, params) => {
    if (method !== "session/update") return;
    const update = params?.update;
    const sid = params?.sessionId;
    if (!update || (activeSessionId && sid && sid !== activeSessionId)) return;
    if (update.sessionUpdate === "tool_call") {
      const tool = extractOndenToolName(update, ONDEN_MCP_SERVER_NAME);
      if (tool) onProgress?.({ kind: "action", tool });
    } else if (update.sessionUpdate === "agent_message_chunk") {
      const text = extractUpdateText(update.content);
      if (text) {
        chunks += text;
        if (chunks.length > MAX_OUTPUT_BYTES) {
          tooLong = true;
          transport.destroy();
        } else {
          onProgress?.({ kind: "message", text });
        }
      }
    }
  });

  try {
    await transport.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "onden-ai-answerer", version: "0.1.0" },
    }, remaining());
    const created = await transport.request("session/new", {
      cwd,
      mcpServers: acpMcpServers(mcpUrl, sessionKey),
    }, remaining());
    activeSessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
    if (!activeSessionId) return { ok: false, reason: "tool_error" };
    const promptResult = await transport.request("session/prompt", {
      sessionId: activeSessionId,
      prompt: [{ type: "text", text: composeAcpPrompt(system, prompt) }],
    }, remaining());
    if (tooLong) return { ok: false, reason: "too_long" };
    if (cancelled) return { ok: false, reason: "cancelled" };
    if (timedOut) return { ok: false, reason: "timeout" };
    const fallback = typeof promptResult?.text === "string" ? promptResult.text : "";
    const text = (chunks || fallback).trim();
    return text ? { ok: true, text } : { ok: false, reason: "empty" };
  } catch {
    if (tooLong) return { ok: false, reason: "too_long" };
    if (cancelled) return { ok: false, reason: "cancelled" };
    if (timedOut) return { ok: false, reason: "timeout" };
    if (transport.hadSpawnError()) return { ok: false, reason: "not_started" };
    return { ok: false, reason: transport.sawJson() ? "tool_error" : "not_json" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    transport.destroy();
  }
}

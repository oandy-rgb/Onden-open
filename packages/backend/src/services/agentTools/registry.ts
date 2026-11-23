import type { ActorCtx } from "../../types.js";
import { appendEventAsCurrentActor } from "../../spine/currentActor.js";
import type { AgentTool, ToolCtx } from "./types.js";
import { assertToolAllowed, isToolAllowed, withToolAuthority, ScopeError } from "../../spine/toolScope.js";
import { checkRateLimit, RateLimitError } from "./rateLimit.js";
import { auditRefusalOnce } from "./auditOnce.js";
import { sessionRootForCall } from "../agentSessionGuard.js";
import { runCascade } from "../../spine/mutate.js";
import { searchNodes } from "./searchNodes.js";
import { getNodeTool } from "./getNode.js";
import { getAttachment } from "./getAttachment.js";
import { createNode } from "./createNode.js";
import { updateNode } from "./updateNode.js";
import { suggestEdit } from "./suggestEdit.js";
import { commentOnNote } from "./commentOnNote.js";
import { applyTag } from "./applyTag.js";
import { removeTag } from "./removeTag.js";
import { queryView } from "./queryView.js";
import { listChildren } from "./listChildren.js";
import { listSpaces } from "./listSpaces.js";
import { listSuggestions } from "./listSuggestions.js";
import { loadSkill } from "./loadSkill.js";
import { proposeTagPack } from "./proposeTagPack.js";
import { getSessionLog, listMySessions } from "./sessionMemory.js";
import { ModuleNotImportedError } from "../workspaceModules.js";

// Built-in registry. Day 4-5 adds write tools (updateNode/applyTag/queryView).
// Third-party tools register via `register(tool)` once the plugin API lands
// (project_feature_plugin_api).

const TOOLS = new Map<string, AgentTool>();
// The tools registered below by this file (not by a module): offered only where
// the ai module is on, once the module installs its gate (gateCoreAgentTools).
const CORE_TOOLS = new Set<string>();
let coreToolsOn: ((workspaceId: string) => Promise<boolean>) | null = null;

/** The ai module's switch for the built-in tools. Until a module installs it
 *  (unit tests that mount nothing) they are always offered. */
export function gateCoreAgentTools(isOn: (workspaceId: string) => Promise<boolean>): void {
  coreToolsOn = isOn;
}

async function assertCoreToolsOn(workspaceId: string, toolName: string): Promise<void> {
  if (CORE_TOOLS.has(toolName) && coreToolsOn && !(await coreToolsOn(workspaceId))) throw new ModuleNotImportedError("ai");
}

function register(tool: AgentTool): void {
  const existing = TOOLS.get(tool.name);
  // Re-registering the EXACT same tool object is a no-op — mountModules() may
  // run more than once in a process (every module-seam test re-mounts the live
  // MODULES). A different tool claiming a taken name is still a hard error: the
  // duplicate guard exists to catch two modules colliding on a name.
  if (existing) {
    if (existing === tool) return;
    throw new Error(`Tool '${tool.name}' already registered`);
  }
  TOOLS.set(tool.name, tool);
}

function registerCore(tool: AgentTool): void {
  register(tool);
  CORE_TOOLS.add(tool.name);
}

registerCore(searchNodes as AgentTool);
registerCore(getNodeTool as AgentTool);
registerCore(getAttachment as AgentTool);
registerCore(createNode as AgentTool);
registerCore(updateNode as AgentTool);
registerCore(suggestEdit as AgentTool);
registerCore(commentOnNote as AgentTool);
registerCore(applyTag as AgentTool);
registerCore(removeTag as AgentTool);
registerCore(queryView as AgentTool);
// Browsing: the notes under a note or space, the spaces the agent reaches, and what became of its suggestions (all read-only).
registerCore(listChildren as AgentTool);
registerCore(listSpaces as AgentTool);
registerCore(listSuggestions as AgentTool);
registerCore(loadSkill as AgentTool);
// The agent's own session history (metadata only, read-only): continue or undo with context.
registerCore(listMySessions as AgentTool);
registerCore(getSessionLog as AgentTool);
// semanticSearch + suggestLinks come from the semantic module (modules/semantic),
// which gates them on the workspace having imported it.
// D7 approve-before-apply: files a held tag-pack request, never installs directly.
registerCore(proposeTagPack as AgentTool);

/** Module seam (src/modules): lets a ModuleDefinition contribute tools at
 *  startup — same duplicate guard as the built-ins above. The registry IS the
 *  agent permission boundary ([[agent-capability-surface]]), so a module
 *  registering a tool WIDENS what agents can do: treat it as a security
 *  decision, not plumbing. */
export function registerTool(tool: AgentTool): void {
  register(tool);
}

export function listTools(): AgentTool[] {
  return Array.from(TOOLS.values());
}

/** The tools of `tools` this workspace offers (a switched-off module's tools are not). */
export async function toolsOfferedIn(workspaceId: string, tools: readonly AgentTool[] = listTools()): Promise<AgentTool[]> {
  const coreOn = coreToolsOn ? await coreToolsOn(workspaceId) : true;
  const offered = await Promise.all(tools.map((tool) => CORE_TOOLS.has(tool.name) && !coreOn ? false : tool.available ? tool.available(workspaceId) : true));
  return tools.filter((_, i) => offered[i]);
}

/** The tools `actor` may call in `workspaceId`: all of them for a person or the
 *  native app (no bearer token, or none known yet), a token's allowed_tools
 *  otherwise, without the tools of modules this workspace has off. What the MCP
 *  tools/list and GET /api/mcp/tools show; callTool still re-checks. */
export function toolsAllowedFor(actor: ActorCtx | null, workspaceId: string): Promise<AgentTool[]> {
  return toolsOfferedIn(workspaceId, listTools().filter((tool) => !actor || isToolAllowed(actor, tool.name)));
}

export function getTool(name: string): AgentTool | undefined {
  return TOOLS.get(name);
}

/** The gate every agent call passes before it runs: the token's tool grant,
 *  then the agent's rate budget. `auditName` is what the audit trail calls the
 *  call, `grantedTool` the allowed_tools entry that permits it (they differ for
 *  a prompt, which has no entry of its own). A refusal is audited (once per
 *  token and reason per minute, auditOnce.ts), then thrown.
 *
 *  Scope / rate-limit rejections MUST land in the audit trail too — the catch
 *  in callTool only wraps handler execution, so these used to throw invisibly
 *  and an agent probing outside its template left no trace (found by the
 *  actor-stats integration test). */
async function admitCall(
  auditName: string,
  grantedTool: string,
  ctx: ToolCtx,
): Promise<{ sessionId: string | null; sessionRoot: string | undefined }> {
  const sessionId = ctx.actor.tokenScope?.sessionId ?? null;
  let sessionRoot: string | undefined;
  try {
    assertToolAllowed(ctx.actor, grantedTool);
    // Rate limit only applies to bearer-authenticated actors. Session / native
    // actors have no tokenScope so they bypass — they're trusted humans hitting
    // the same registry from the UI. The budget is the agent's, not each
    // token's: minting a second token for the same agent does not double it.
    if (ctx.actor.tokenScope) {
      await checkRateLimit(`tools:${ctx.actor.id}`);
    }
    if (sessionId) sessionRoot = await sessionRootForCall(sessionId, ctx.workspaceId);
  } catch (err) {
    const reason = err instanceof ScopeError ? err.code : err instanceof RateLimitError ? "rate_limited" : "refused";
    const tokenKey = ctx.actor.tokenScope?.tokenId ?? ctx.actor.id;
    if (!auditRefusalOnce(tokenKey, reason)) throw err;
    await appendEventAsCurrentActor(ctx.actor, ctx.workspaceId,
      "AGENT_TOOL_FAILED",
      "tool",
      auditName,
      { ok: false, duration_ms: 0, scope_rejected: true, message: (err as Error).message },
      { txMeta: { tool_name: auditName, token_id: ctx.actor.tokenScope?.tokenId, ...(sessionId ? { session_id: sessionId } : {}) } },
    );
    throw err;
  }
  return { sessionId, sessionRoot };
}

/** Render a skill as an MCP prompt (prompts/get, prompts/list) through the same
 *  gate as a tool call. A prompt hands the caller note text, so it needs the
 *  grant of getNode, the read tool for note text: a locked-down token
 *  (allowed_tools = []) gets no prompts, and every call spends the agent's
 *  `tools:` rate budget and leaves an audit event. */
export async function callPrompt<T>(promptName: string, ctx: ToolCtx, render: () => Promise<T>): Promise<T> {
  const auditName = `prompt:${promptName}`;
  await assertCoreToolsOn(ctx.workspaceId, PROMPT_GRANT_TOOL);
  await admitCall(auditName, PROMPT_GRANT_TOOL, ctx);
  const started = Date.now();
  try {
    const result = await render();
    await appendEventAsCurrentActor(ctx.actor, ctx.workspaceId, "AGENT_TOOL_CALLED", "tool", auditName, { ok: true, duration_ms: Date.now() - started },
      { txMeta: { tool_name: auditName, token_id: ctx.actor.tokenScope?.tokenId } });
    return result;
  } catch (err) {
    await appendEventAsCurrentActor(ctx.actor, ctx.workspaceId, "AGENT_TOOL_FAILED", "tool", auditName, { ok: false, duration_ms: Date.now() - started, message: (err as Error).message },
      { txMeta: { tool_name: auditName, token_id: ctx.actor.tokenScope?.tokenId } });
    throw err;
  }
}

const PROMPT_GRANT_TOOL = "getNode";

/** Dispatch a tool by name. Throws ScopeError (403) if scope rejects;
 *  Zod errors (400) if args don't parse; tool-internal errors propagate.
 *  Audits success + failure into domain_events. */
export async function callTool(
  toolName: string,
  rawArgs: unknown,
  ctx: ToolCtx,
): Promise<unknown> {
  const tool = TOOLS.get(toolName);
  if (!tool) throw new Error(`Unknown tool '${toolName}'`);
  await assertCoreToolsOn(ctx.workspaceId, toolName);

  const { sessionId, sessionRoot } = await admitCall(toolName, toolName, ctx);

  const args = tool.inputSchema.parse(rawArgs);
  const started = Date.now();
  try {
    // Keep the trusted invocation name through asynchronous waits. The write
    // boundary can then recheck its refreshed token's current tool grant.
    // A session's calls run inside its chain: whatever they write is caused by
    // the session's root event, so the inbox groups it and one reject reverts it.
    const result = await withToolAuthority(toolName, () => sessionId && !ctx.dryRun
      ? runCascade({ actor: ctx.actor, workspaceId: ctx.workspaceId, authority: { kind: "any_space_write" }, causeEventId: sessionRoot }, () => tool.handler(args, ctx))
      : tool.handler(args, ctx));
    // Skip audit on dry-run — the call didn't actually happen.
    if (!ctx.dryRun) {
      await appendEventAsCurrentActor(ctx.actor, ctx.workspaceId,
        "AGENT_TOOL_CALLED",
        "tool",
        toolName,
        { ok: true, duration_ms: Date.now() - started },
        { txMeta: { tool_name: toolName, token_id: ctx.actor.tokenScope?.tokenId, ...(sessionId ? { session_id: sessionId } : {}), args: auditedToolArgs(args) } },
      );
    }
    return result;
  } catch (err) {
    // Always emit failures, even on dry-run — surfaces scope violations the
    // agent attempted to probe. Cleaner forensic signal than silence.
    await appendEventAsCurrentActor(ctx.actor, ctx.workspaceId,
      "AGENT_TOOL_FAILED",
      "tool",
      toolName,
      { ok: false, duration_ms: Date.now() - started, message: (err as Error).message, dry_run: ctx.dryRun ?? false },
      { txMeta: { tool_name: toolName, token_id: ctx.actor.tokenScope?.tokenId, ...(sessionId ? { session_id: sessionId } : {}), args: auditedToolArgs(args) } },
    );
    throw err;
  }
}

/** What a tool call's audit event keeps of its arguments: their names and the
 *  ids they named (note, tag, parent, space…), never text. A tool-call event is
 *  not about one note, so its readers are the owner and the agent
 *  (services/eventVisibility.ts); the text an agent writes or searches for
 *  belongs to the notes themselves, under their space's read rule. */
export function auditedToolArgs(args: unknown): { keys: string[]; ids: Record<string, unknown> } {
  if (!args || typeof args !== "object") return { keys: [], ids: {} };
  const entries = Object.entries(args as Record<string, unknown>);
  const isId = (key: string) => key === "id" || /(_id|_ids|Id|Ids)$/.test(key);
  const idValue = (value: unknown) => typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
  return {
    keys: entries.map(([key]) => key),
    ids: Object.fromEntries(entries.filter(([key, value]) => isId(key) && idValue(value))),
  };
}

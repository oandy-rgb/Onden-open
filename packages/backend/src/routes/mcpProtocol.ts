import { Hono } from "hono";
import { createContextSlot } from "../requestContext.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { toolsAllowedFor, callTool, callPrompt } from "../services/agentTools/index.js";
import { RateLimitError, mcpSafeError, isCallerFacingFailure } from "../services/agentTools/index.js";
import type { AgentTool } from "../services/agentTools/index.js";
import { prompt, skills, InvalidSkillRequest, ScopeUnavailable, type Scope } from "../services/harness/index.js";
import type { SkillSummary } from "@onden/contract";
import { ScopeError } from "../spine/toolScope.js";
import { AuthorityError } from "../spine/mutate.js";
import { ActorGoneError } from "../spine/actor.js";
import { actorGoneDuring } from "../spine/currentActor.js";
export { mcpSafeError };

// MCP-protocol surface (JSON-RPC over Streamable HTTP) alongside the
// Onden-flavored REST surface at /api/mcp/tools/*. Both wrap the same
// tool registry — REST is the convenience API for curl/scripts; this
// route is what native MCP clients (desktop and command-line MCP clients) speak.
//
// Stateless transport — no sessionIdGenerator. Each HTTP request is
// independent. Avoids session cleanup complexity; works for short-lived
// agent calls. Stateful upgrade is a Day 8+ option if streaming
// notifications become a requirement.
//
// Actor context flows via AsyncLocalStorage: Hono middleware resolves the
// Bearer token → ActorCtx → we open a store before `handleRequest` runs,
// each tool handler reads the store. Async chains preserve the context;
// concurrent requests don't bleed.

// `actorGone`: a callback failed because this request's identity is gone since it signed in (spine/currentActor.ts actorGoneDuring). The
// SDK turns a callback's failure into a tool error inside a 200, so the route reads it here once the answer is complete and refuses the
// request 401 instead, the answer every other entry gives (httpError.ts).
type RequestCtx = { actor: ActorCtx; workspaceId: string; actorGone: boolean };
const requestCtx = createContextSlot<RequestCtx>();

// Extract the underlying ZodObject's raw shape — registerTool's
// `inputSchema` field expects ZodRawShape.
//
// Zod 4 keeps `.refine()` as ZodObject (no longer wraps in ZodEffects).
// Refine predicates are NOT visible at the MCP-protocol surface (clients
// only see the field shape). Final validation still runs inside `callTool`
// via `tool.inputSchema.parse(rawArgs)` with the full schema; a refine
// failure surfaces as a Zod error and the JSON-RPC envelope returns a tool error.
function shapeForRegister(tool: AgentTool): z.ZodRawShape {
  const schema: unknown = tool.inputSchema;
  if (schema instanceof z.ZodObject) return schema.shape as z.ZodRawShape;
  throw new Error(`tool '${tool.name}' has unsupported input schema for MCP registerTool`);
}

// Skills as MCP prompts: the caller's catalogue (built-in skills and their
// own skill notes, services/harness) becomes prompts/list; prompts/get renders
// the skill on a scope with harness.prompt() — the outside AI runs it itself.
// Every argument is an optional string (the protocol's shape); which scope a
// call means is read from the ones the skill takes.
const PROMPT_ARGS = {
  query: z.string().optional().describe("Search scope: the question (ask)"),
  text: z.string().optional().describe("Text scope: the text to work on"),
  node_ids: z.string().optional().describe("Nodes scope: note ids, comma-separated"),
  tag_id: z.string().optional().describe("Tag scope: a tag id"),
  board_id: z.string().optional().describe("Board scope: a whiteboard (or tag board) id; cards in reading order"),
  input: z.string().optional().describe("An extra instruction for this run"),
};
type PromptArgs = { query?: string; text?: string; node_ids?: string; tag_id?: string; board_id?: string; input?: string };

/** The scope a prompts/get call means, among those the skill takes. */
export function promptScope(skill: Pick<SkillSummary, "scopes" | "name">, args: PromptArgs): Scope {
  const ids = (args.node_ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  for (const kind of skill.scopes) {
    if (kind === "search" && args.query) return { kind, query: args.query };
    if (kind === "text" && args.text) return { kind, text: args.text };
    if (kind === "nodes" && ids.length) return { kind, ids: ids.slice(0, 20) };
    if (kind === "tag" && args.tag_id) return { kind, tagId: args.tag_id };
    if (kind === "board" && args.board_id) return { kind, boardId: args.board_id };
  }
  const want = skill.scopes.map((k) => ({ search: "query", text: "text", nodes: "node_ids", tag: "tag_id", board: "board_id" })[k]).join(" or ");
  throw new InvalidSkillRequest(`${skill.name} needs ${want}`);
}

const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try { return await fn(...args); } catch (err) {
      const ctx = requestCtx.getStore();
      if (ctx && !isCallerFacingFailure(err) && await actorGoneDuring(ctx.actor, err)) ctx.actorGone = true;
      throw mcpSafeError(err);
    }
  };

const promptName = (skill: SkillSummary) => (skill.kind === "builtin" ? skill.id : `skill-${skill.id}`);

// Prompts go through the tools' gate (callPrompt): a token that may not read
// note text is refused (and audited), and every get spends the agent's rate budget.
// prompts/list shows only the skills switched on for the AI (「給 AI 用」); one
// that is off is still served when this request names it (prompts/get).
async function registerSkillPrompts(s: McpServer, ctx: { actor: ActorCtx; workspaceId: string }, named: ReadonlySet<string>): Promise<void> {
  for (const skill of await skills(ctx.actor, ctx.workspaceId)) {
    if (!skill.aiUse && !named.has(promptName(skill))) continue;
    s.registerPrompt(promptName(skill), { title: skill.name, description: skill.description, argsSchema: PROMPT_ARGS }, guarded(async (args) => {
      const { input, ...scopeArgs } = args as PromptArgs;
      const rendered = await callPrompt(promptName(skill), ctx, () =>
        prompt({ ...ctx, skill: skill.id, scope: promptScope(skill, scopeArgs), input }));
      // MCP prompts carry no system role: the instructions lead the first message.
      const messages = rendered.messages.map((m, i) => ({
        role: m.role,
        content: { type: "text" as const, text: i === 0 && rendered.system ? `${rendered.system}\n\n---\n\n${m.content}` : m.content },
      }));
      return { description: skill.description, messages };
    }));
  }
}

// Registers only the tools the actor may call, so tools/list shows a token its
// own surface; callTool still re-checks the grant on every call.
async function buildMcpServer(ctx: { actor: ActorCtx; workspaceId: string }, namedPrompts: ReadonlySet<string>): Promise<McpServer> {
  const s = new McpServer(
    { name: "onden", version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} } },
  );
  await registerSkillPrompts(s, ctx, namedPrompts);
  for (const tool of await toolsAllowedFor(ctx.actor, ctx.workspaceId)) {
    s.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: shapeForRegister(tool),
      },
      guarded(async (args: unknown) => {
        const ctx = requestCtx.getStore();
        if (!ctx) throw new Error("MCP tool called outside request context");
        const result = await callTool(tool.name, args, ctx);
        return {
          content: tool.mcpContent
            ? tool.mcpContent(result)
            : [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }),
    );
  }
  return s;
}

/** prompts/list is answered from the per-request server build, which has no
 *  per-call hook, so it is gated here: the same rate budget and audit as a
 *  prompts/get. Returns a JSON-RPC error body when the gate refuses, else null. */
type RpcCall = { method?: unknown; id?: unknown; params?: { name?: unknown } } | null;
async function rpcCalls(req: Request): Promise<RpcCall[]> {
  if (req.method !== "POST") return [];
  const body: unknown = await req.clone().json().catch(() => null);
  return (Array.isArray(body) ? body : [body]) as RpcCall[];
}

/** The prompts a request asks for by name (prompts/get). */
const namedPrompts = (calls: RpcCall[]) =>
  new Set(calls.flatMap((call) => call?.method === "prompts/get" && typeof call.params?.name === "string" ? [call.params.name] : []));

async function gatePromptsList(calls: RpcCall[], ctx: { actor: ActorCtx; workspaceId: string }) {
  const list = calls.find((m) => m?.method === "prompts/list");
  if (!list) return null;
  try {
    await callPrompt("list", ctx, async () => undefined);
    return null;
  } catch (err) {
    if (!isCallerFacingFailure(err) && await actorGoneDuring(ctx.actor, err)) throw new ActorGoneError();
    return { jsonrpc: "2.0", id: list.id ?? null, error: { code: -32001, message: err instanceof RateLimitError ? err.message : "not allowed" } };
  }
}

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.all("/", async (c) => {
  const actor = c.get("actor");
  if (!actor) {
    return c.json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "unauthorized — bearer token required" },
      id: null,
    }, 401);
  }
  const workspaceId = await getWorkspaceId();
  const calls = await rpcCalls(c.req.raw);
  const gated = await gatePromptsList(calls, { actor, workspaceId });
  if (gated) return c.json(gated, 200);
  // Stateless transport is single-use per SDK contract — build fresh
  // server + transport per request. ~6 registerTool calls + 1 server
  // construction; sub-ms overhead.
  const server = await buildMcpServer({ actor, workspaceId }, namedPrompts(calls));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  const ctx: RequestCtx = { actor, workspaceId, actorGone: false };
  return requestCtx.run(ctx, async () => {
    const res = await transport.handleRequest(c.req.raw);
    if (c.req.method !== "POST" || !res.body) return res;
    // Stateless: the answer to a POST (JSON, or an event stream that closes once every response in it is written) is read to its end
    // before it is sent, so a callback that found the identity gone can still turn the whole request into the 401.
    const body = await res.arrayBuffer();
    if (ctx.actorGone) throw new ActorGoneError();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
});

export default router;

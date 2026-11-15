import { requireActor } from "../spine/mutate.js";
import { Hono } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { toolsAllowedFor, getTool, callTool } from "../services/agentTools/index.js";
import { toolOnError } from "../httpError.js";
import { readJsonBody } from "./params.js";

// HTTP surface for agent tools. Day 3 ships REST-shaped endpoints; Day 4-5
// wraps with the MCP protocol (streamable-http transport) for native MCP
// clients. The tool registry is transport-agnostic so both surfaces share it.
//
// Errors return structured JSON the way Blinko admins wished theirs did:
//   400  invalid_args       — zod parse failure; detail = zod issues
//   403  tool_not_allowed   — token's allowed_tools whitelist rejects
//   404  unknown_tool       — toolName not in registry
//   429  rate_limited       — per-agent meter, shared by its tokens (Retry-After header)
//   Every error goes through httpError.ts toolOnError: the codes above, and
//   the shared boundary for the rest (name conflicts 409, a module that is
//   not imported 409, unknown failures 500 without database details).
//
// Audit: every call is emitted as AGENT_TOOL_CALLED / AGENT_TOOL_FAILED in
// domain_events with tx_meta.{tool_name, token_id, args}. EventLogPanel
// filtering by actor_type='ai_agent' surfaces the full agent trail.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();
router.onError(toolOnError);

router.get("/tools", async (c) => {
  // The tools this caller may call (a token: its allowed_tools), the same
  // listing as the MCP `tools/list` JSON-RPC method.
  const tools = (await toolsAllowedFor(c.get("actor"), await getWorkspaceId())).map((t) => ({
    name: t.name,
    description: t.description,
    // We don't JSON-serialize the Zod schema here — zod 4's z.toJSONSchema can
    // when the MCP surface needs it. Callers using this REST endpoint can read
    // tool docs separately for now.
  }));
  return c.json({ tools });
});

router.post("/tools/:toolName", async (c) => {
  const actor = requireActor(c.get("actor"));
  const { toolName } = c.req.param();

  if (!getTool(toolName)) {
    return c.json({ error: "unknown_tool", tool: toolName }, 404);
  }

  const body = await readJsonBody(c, { optional: true }) as { args?: unknown };
  const workspaceId = await getWorkspaceId();
  const dryRun = c.req.query("dryRun") === "true";

  const result = await callTool(toolName, body.args ?? body, {
    actor,
    workspaceId,
    dryRun,
  });
  return c.json({ ok: true, result, ...(dryRun ? { dryRun: true } : {}) });
});

export default router;

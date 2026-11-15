import type { ModuleDefinition } from "../types.js";
import agentSessionsRouter from "../../routes/agentSessions.js";
import aiSuggestionsRouter from "../../routes/aiSuggestions.js";
import mcpSessionsRouter from "../../routes/mcpSessions.js";
import aiRuntimeRouter from "../../routes/aiRuntime.js";
import aiPanelChatRouter from "../../routes/aiPanelChat.js";
import mcpRouter from "../../routes/mcp.js";
import mcpProtocolRouter from "../../routes/mcpProtocol.js";
import { q, getWorkspaceId } from "../../db.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";

// AI: everything that lets an AI act in the workspace, as one module that can be
// switched off (owner, 2026-11-01: 「把 AI 整個做成可以關掉的模組」). It is a
// confirm-once module: a new workspace has it off, and it comes on only when the
// owner agrees once (the stance of consent: nothing about AI is on behind their back).
//
// Off means:
//   • /api/agent-sessions, /api/ai-suggestions, /api/ai (roles, keys, panel chat,
//     selection actions), /api/mcp (tokens, tools, sessions, protocol): writes
//     answer 409 module_not_imported (moduleWriteGate); a runner's
//     GET /api/mcp/sessions/pending lists nothing, so queued work is not claimed;
//   • the built-in agent tools (searchNodes, getNode, updateNode…) are not
//     offered and refuse (gatesCoreAgentTools, services/agentTools/registry);
//   • on the client, the info panel's AI tab, @-mentions, 「交給 AI」, the selection
//     and paragraph AI actions, pending suggestions in 「等你決定」, the AI roles and
//     key settings and the 「AI 改過」 history filter are gone (frontend/modules/ai).
// Nothing is deleted: roles, keys, tokens, sessions, suggestions and history stay,
// and turning the module on again brings them back as they were. Skills need this
// module (library.requires): off, they stop being offered too.

export const AI_MODULE = "ai";

/** An existing workspace that already has an AI role, a live key or an MCP token
 *  counts as using AI, so the first library run (and migration 159) keeps it on. */
async function aiInUse(workspaceId: string): Promise<boolean> {
  const r = await q(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM agent_runners WHERE workspace_id = $1)
                 OR EXISTS (SELECT 1 FROM ai_credentials WHERE workspace_id = $1 AND revoked_at IS NULL)
                 OR EXISTS (SELECT 1 FROM agent_tokens t JOIN actors a ON a.id = t.actor_id WHERE a.workspace_id = $1 AND t.revoked_at IS NULL)`,
    [workspaceId],
  );
  return r.rows.length > 0;
}

export const aiModule: ModuleDefinition = {
  id: AI_MODULE,
  gatesCoreAgentTools: true,
  routePrefixes: ["/api/agent-sessions", "/api/ai-suggestions", "/api/ai", "/api/mcp"],
  // Settings › AI is where the module is turned on: testing a key writes nothing, so it works first.
  readOnlyPosts: /^\/api\/ai\/credentials\/(test|[^/]+\/test)$/,
  registerRoutes: (app) => {
    // A runner that polls for work while the module is off is told there is none.
    app.use("/api/mcp/sessions/pending", async (c, next) => {
      if (c.req.method === "GET" && !(await workspaceHasModule(await getWorkspaceId(), AI_MODULE))) return c.json({ sessions: [] });
      await next();
    });
    app.route("/api/agent-sessions", agentSessionsRouter);
    app.route("/api/ai-suggestions", aiSuggestionsRouter);
    app.route("/api/mcp/sessions", mcpSessionsRouter);
    app.route("/api/ai", aiRuntimeRouter);
    app.route("/api/ai/panel-chat", aiPanelChatRouter);
    app.route("/api/mcp", mcpRouter);
    app.route("/api/mcp/protocol", mcpProtocolRouter);
  },
  library: {
    confirmOnce: true,
    inUse: aiInUse,
  },
};

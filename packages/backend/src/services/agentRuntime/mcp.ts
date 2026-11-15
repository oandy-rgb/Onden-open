// The MCP runtime: the owner's own AI client connects with the role's token
// (routes/mcpProtocol.ts). Onden cannot start it; a session for such a role just waits
// `queued` until that AI client comes for it. The client may be opened by hand, or be one
// kept on a machine that long-polls /api/mcp/sessions/pending and claims what it finds
// (routes/mcpSessions.ts, agentSessions.claimSession): the same role key, the same queue.
// How long since either came is the role's `last_seen_at` (services/aiRoles.ts), not a state.
import { q } from "../../db.js";
import type { AgentRuntime } from "./types.js";

export const mcpRuntime: AgentRuntime = {
  kind: "mcp",
  async availability(role) {
    if (!role.enabled) return { ok: false, reason: "agent_disabled" };
    const token = await q(
      `SELECT 1 FROM agent_tokens WHERE actor_id = $1 AND session_id IS NULL AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, [role.actor_id]);
    return token.rows.length > 0 ? { ok: true } : { ok: false, reason: "no_token" };
  },
  async dispatch() {
    // Passive by design: nothing to call.
  },
};

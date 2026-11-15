import { q } from "../db.js";
import { UnauthorizedError } from "./actor.js";
import type { ActorCtx, ActorType, TokenAccess, WriteMode } from "../types.js";
import { assertCurrentToolAllowed } from "./toolScope.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "./systemActor.js";

/** Reload authority using IDs from trusted authentication or a durable intent.
 * Earlier role/scopes are never grants. Call inside the read snapshot, or AFTER
 * acquiring the workspace event lock and BEFORE any write in that transaction.
 * Returns a new value; never mutates a request's captured actor. Missing actors,
 * workspace mismatch and invalid/mismatched tokens are 401; DB errors propagate.
 * A token held by the built-in System actor is never valid: System cannot be
 * given tokens (services/actors.ts), and one minted before that rule is
 * refused here rather than deleted.
 * Does not authenticate client-supplied IDs or revalidate session cookies.
 * Example: resolveCurrentActor(authenticatedActor, workspaceId). */
export async function resolveCurrentActor(
  identity: { id: string; tokenScope?: { tokenId: string } },
  workspaceId: string,
): Promise<ActorCtx> {
  const tokenId = identity.tokenScope?.tokenId ?? null;
  if (identity.tokenScope && !tokenId) throw new UnauthorizedError();
  const result = await q<{
    id: string; name: string; type: ActorType;
    token_id: string | null;
    allowed_tools: string[] | null; access: TokenAccess | null; write_mode: WriteMode; session_write_mode: WriteMode | null;
    expires_at: Date | null; issued_by: string | null; session_id: string | null;
  }>(
    `SELECT a.id, a.name, a.type, a.write_mode, s.write_mode AS session_write_mode,
            t.id AS token_id, t.allowed_tools, t.access, t.expires_at, t.issued_by::text AS issued_by, t.session_id::text AS session_id
       FROM actors a
       LEFT JOIN agent_tokens t ON t.id::text=$3 AND t.actor_id=a.id
       LEFT JOIN agent_sessions s ON s.id = t.session_id
      WHERE a.id::text=$1 AND a.workspace_id=$2
        AND ($3::text IS NULL OR (t.id IS NOT NULL AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > statement_timestamp())
          AND a.external_id IS DISTINCT FROM ${SYSTEM_EXTERNAL_ID_SQL}))`,
    [identity.id, workspaceId, tokenId],
  );
  const row = result.rows[0];
  if (!row) throw new UnauthorizedError();
  const current: ActorCtx = {
    id: row.id, name: row.name, type: row.type,
    ...(row.token_id ? { tokenScope: {
      tokenId: row.token_id, allowedTools: row.allowed_tools, access: row.access ?? "read", expiresAt: row.expires_at,
      // The session's own mode can only tighten the agent's: an api session is 'suggest' (the database
      // requires it) even for an agent set to 'apply'.
      writeMode: row.session_write_mode === "suggest" ? "suggest" : row.write_mode,
      issuedBy: row.issued_by, sessionId: row.session_id,
    } } : {}),
  };
  assertCurrentToolAllowed(current);
  return current;
}

import { randomBytes } from "node:crypto";
import { getWorkspaceId, pool, q } from "../db.js";
import { UnauthorizedError } from "../spine/actor.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import type { ActorCtx, TokenAccess } from "../types.js";
import { sha256Hex } from "../utils.js";

// Token format: "ondt_" + 32 url-safe base64 bytes. ~256 bits of entropy.
// "ondt" = onden token; the prefix lets admins recognise these in logs.
const TOKEN_PREFIX = "ondt_";

export function generateRawToken(): string {
  // 32 bytes → 43 url-safe chars; trim any padding (=) — fixed length per token.
  const raw = randomBytes(32).toString("base64url");
  return TOKEN_PREFIX + raw;
}

export type CreateTokenOpts = {
  name?: string;
  /** read or write (types.ts TokenAccess). Defaults to read: a token never
   *  writes unless asked to. */
  access?: TokenAccess;
  /** The tool surface stored with the token; callers expand it from `access`
   *  (agentTools/templates.ts toolsForAccess). null = every tool. */
  allowedTools?: string[] | null;
  expiresAt?: Date | string | null;
  /** Who issued the token: kept for audit, and the token is revoked with them
   *  (revokeTokensIssuedBy). It no longer bounds the token's spaces. */
  issuedBy?: string | null;
  /** A session token (services/agentSessions.ts claimSession): bound to that
   *  one session, revoked when it ends. */
  sessionId?: string | null;
};

/** Mint a new token row. Returns the plaintext; only the hash is stored. */
export async function createToken(
  actorId: string,
  opts: CreateTokenOpts = {},
): Promise<{ id: string; plaintext: string }> {
  const plaintext = generateRawToken();
  // q() (tx-aware) so a caller wrapping this in the spine's mutate() gets the
  // token INSERT and the TOKEN_CREATED audit event in one atomic transaction.
  const res = await q<{ id: string }>(
    `INSERT INTO agent_tokens
       (actor_id, token_hash, name, access, allowed_tools, expires_at, issued_by, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      actorId,
      sha256Hex(plaintext),
      opts.name ?? "",
      opts.access ?? "read",
      opts.allowedTools ?? null,
      opts.expiresAt ?? null,
      opts.issuedBy ?? null,
      opts.sessionId ?? null,
    ],
  );
  return { id: res.rows[0].id, plaintext };
}

/** Change a live token's access (and the tool list that goes with it) in place,
 *  without rotating the secret. Returns true if a live row was updated, false
 *  if the token is missing or already revoked (re-setting access is not a way
 *  to revive one). Like createToken/revokeToken this uses q() so it joins the
 *  caller's spine tx. */
export async function setTokenAccess(
  actorId: string,
  tokenId: string,
  opts: { access: TokenAccess; allowedTools: string[] | null; issuedBy?: string },
): Promise<boolean> {
  const res = await q(
    `UPDATE agent_tokens SET access = $3, allowed_tools = $4, issued_by = COALESCE($5, issued_by)
      WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
    [tokenId, actorId, opts.access, opts.allowedTools, opts.issuedBy ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Soft-revoke. Sets revoked_at if not already set (idempotent). Returns true
 *  if a row transitioned to revoked, false if already revoked or not found. */
export async function revokeToken(actorId: string, tokenId: string): Promise<boolean> {
  const res = await q(
    `UPDATE agent_tokens
       SET revoked_at = now()
     WHERE id = $1 AND actor_id = $2 AND revoked_at IS NULL`,
    [tokenId, actorId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** A member is leaving: soft-revoke every live token they issued, whichever
 *  agent holds it, and mark it issuer-removed (migration 102) so it stays
 *  empty even though issued_by becomes NULL with the actor row. Call inside
 *  the removal's mutate(), before the actor row is deleted. Returns the ids
 *  revoked (empty when they issued none). */
export async function revokeTokensIssuedBy(workspaceId: string, issuerId: string): Promise<string[]> {
  const res = await q<{ id: string }>(
    `UPDATE agent_tokens
        SET revoked_at = now(), issuer_removed_at = now()
      WHERE issued_by = $1 AND revoked_at IS NULL
        AND actor_id IN (SELECT id FROM actors WHERE workspace_id = $2)
      RETURNING id`,
    [issuerId, workspaceId],
  );
  return res.rows.map((row) => row.id);
}

/** Resolve a bearer-token string to its actor, or null if unknown / revoked /
 *  expired / not of this workspace. The token is found by its hash; the actor
 *  and the token's scope then come from resolveCurrentActor — the same query
 *  (workspace, revocation, expiry at statement_timestamp()) every write
 *  re-checks. Updates last_used_at on hit. */
export async function resolveBearerActor(rawToken: string, workspaceId?: string): Promise<ActorCtx | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  const token = (await pool.query<{ id: string; actor_id: string }>(
    `SELECT id, actor_id FROM agent_tokens WHERE token_hash = $1`,
    [sha256Hex(rawToken)],
  )).rows[0];
  if (!token) return null;
  let actor: ActorCtx;
  try {
    actor = await resolveCurrentActor({ id: token.actor_id, tokenScope: { tokenId: token.id } }, workspaceId ?? await getWorkspaceId());
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
  // Touch last_used_at, but don't block the request on it.
  void pool.query(`UPDATE agent_tokens SET last_used_at = now() WHERE id = $1`, [token.id]);
  return actor;
}

/** Parse "Authorization: Bearer ondt_..." → raw token, or null. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

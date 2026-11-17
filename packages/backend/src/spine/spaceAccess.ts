// The ONE answer to "what may this actor do in this space"
// (docs/architecture/proposals/roles-owner-member-2026-10-22.md §3.3).
//
// The rule is written once, as the SQL below. Every other question — the
// readable-space subquery in a list query, the per-note write check, the spine
// `space` authority — is that SQL with a different filter, so a rule change
// cannot reach one gate and miss another.
//
//   read(actor, S)   = S is not deleted ∧ actor is a member of S
//                      ∧ (token: S.external_ai is on)
//   write(actor, S)  = read ∧ the member's permission is 'edit'
//                      ∧ (token: its access is 'write')
//   manage(actor, S) = the workspace owner on a SHARED space, or a person on
//                      their own PERSONAL space; never a token
//
// Members are people, AI agents and temporary sessions alike: one table, one permission. A temporary session is also never wider than
// the person who opened it (temporarySql in spaceAccessSql). An
// agent's reach is its own membership; its token only narrows it (read-only,
// or "no external AI" via the space switch).
//
// A `manage` holder may act at every level through the spine `space`
// authority (the owner steps into a shared space without being a member), but
// that does not make the space readable: `read` stays membership.
//
// Callers pass an actor that came from resolveCurrentActor (currentActor.ts).

import { q } from "../db.js";
import { replicatedAuthor } from "./replicatedOp.js";
import type { ActorCtx } from "../types.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "./systemActor.js";
import type { AccessBlock, SpacePermission } from "@onden/contract";

/** What a member may do in a space. Adding a level later = this list, the
 *  space_members CHECK, and the CASE in spaceAccessSql. */
export const SPACE_PERMISSIONS = ["view", "edit"] as const satisfies readonly SpacePermission[];
/** What space_members may hold: also `suggest` (migration 174), the stranger role of a collaboration link in distributed sync:
 *  a member (so it reads) whose permission is not 'edit' (so it never writes). Only the sync projection stores it; the members
 *  API offers SPACE_PERMISSIONS. */
export type StoredSpacePermission = SpacePermission | "suggest";

export function isSpacePermission(value: unknown): value is SpacePermission {
  return typeof value === "string" && (SPACE_PERMISSIONS as readonly string[]).includes(value);
}

// ── The rule ───────────────────────────────────────────────────────────────

/** What an actor may do in one space. */
export type SpaceAccess = { read: boolean; write: boolean; manage: boolean };

/** SQL predicate: the workspace-owner rule, over `workspaces` and `actors`
 *  aliases the caller joins: the stored owner, or the built-in System account
 *  (the owner on the native app). A workspace with no owner has none — there is
 *  no fallback to admins. Used by spine isWorkspaceOwner and by the `manage`
 *  column below, so "who is the owner" is written once. */
export function workspaceOwnerSql(actorIdAlias = "a", workspaceAlias = "w"): string {
  return `(${workspaceAlias}.owner_actor_id = ${actorIdAlias}.id OR ${actorIdAlias}.external_id = ${SYSTEM_EXTERNAL_ID_SQL})`;
}

/** The rule as a subquery body: one row per live space of the actor's
 *  workspace, `(space_id, can_read, can_write, can_manage)`, with `$n` bound
 *  into `params`. Filter it (`WHERE can_read`) rather than re-deriving it.
 *  `can_manage` is false unless `opts.manage` asks for it. */
export function spaceAccessSql(actor: ActorCtx | null, params: unknown[], opts: { manage?: boolean } = {}): string {
  const a = params.push(actor?.id ?? "");
  // Replaying a validated replicated op: the engine decided, not today's membership rows (spine/replicatedOp.ts).
  if (replicatedAuthor(actor)) {
    return `SELECT s.id AS space_id, true AS can_read, true AS can_write, true AS can_manage
              FROM spaces s WHERE s.deleted_at IS NULL AND s.workspace_id = (SELECT workspace_id FROM actors WHERE id::text = $${a})`;
  }
  const token = actor?.tokenScope;
  // A token reaches only spaces that let external AI in, and writes only when
  // its access is 'write'.
  // A session token (services/agentSessions.ts claimSession) reaches only the
  // space of the note it was sent from, and only while the person who sent it
  // can still read (write) there: the agent acts for them.
  const sessionSql = (permission: string) => {
    if (!token?.sessionId) return "";
    const p = params.push(token.sessionId);
    return ` AND EXISTS (SELECT 1 FROM agent_sessions x JOIN space_members sm ON sm.space_id = x.space_id AND sm.actor_id = x.initiator_id
                          WHERE x.id::text = $${p} AND x.space_id = s.id${permission})`;
  };
  // A temporary session (participant_sessions) is a member of the spaces it was opened on and never reaches further than the person
  // it acts for reaches NOW: a space that person has left, or may no longer write in, is closed to the session at the same moment.
  const temporarySql = (permission: string) => {
    if (actor?.type !== "session") return "";
    return ` AND EXISTS (SELECT 1 FROM participant_sessions ps JOIN space_members om ON om.actor_id = ps.opened_by AND om.space_id = s.id
                          WHERE ps.actor_id::text = $${a}${permission})`;
  };
  const tokenRead = token ? ` AND s.capabilities->>'external_ai' = 'true'${sessionSql("")}` : temporarySql("");
  const tokenWrite = token ? ` AND s.capabilities->>'external_ai' = 'true'${sessionSql(" AND sm.permission = 'edit'")} AND ${token.access === "write" ? "true" : "false"}` : temporarySql(" AND om.permission = 'edit'");
  // can_manage is computed only when asked for (it consults the owner row); the
  // readable / writable subqueries that run inside every list query skip it.
  const manage = token || !opts.manage
    ? "false" // a delegated token never manages a space; agents only propose
    : `(s.owner_actor_id::text = $${a} AND s.kind = 'personal'
        OR (s.kind = 'shared' AND EXISTS (
             SELECT 1 FROM actors oa JOIN workspaces w ON w.id = oa.workspace_id
              WHERE oa.id::text = $${a} AND ${workspaceOwnerSql("oa", "w")})))`;
  return `SELECT s.id AS space_id,
                (m.actor_id IS NOT NULL${tokenRead}) AS can_read,
                (m.permission = 'edit'${tokenWrite}) AS can_write,
                ${manage} AS can_manage
           FROM spaces s
           LEFT JOIN space_members m ON m.space_id = s.id AND m.actor_id::text = $${a}
          WHERE s.deleted_at IS NULL
            AND s.workspace_id = (SELECT workspace_id FROM actors WHERE id::text = $${a})`;
}

/** The actor's access to `spaceId`, or null when the space does not exist (or
 *  was deleted). */
export async function spaceAccess(actor: ActorCtx, spaceId: string): Promise<SpaceAccess | null> {
  const params: unknown[] = [spaceId];
  const r = await q<{ can_read: boolean; can_write: boolean; can_manage: boolean }>(
    `SELECT can_read, COALESCE(can_write, false) AS can_write, can_manage
       FROM (${spaceAccessSql(actor, params, { manage: true })}) x WHERE x.space_id = $1`, params);
  const row = r.rows[0];
  return row ? { read: row.can_read, write: row.can_write, manage: row.can_manage } : null;
}

/** SQL for the ids of the spaces `actor` may READ (a subquery body). */
export function readableSpaceIdsSql(actor: ActorCtx | null, params: unknown[]): string {
  return `SELECT x.space_id FROM (${spaceAccessSql(actor, params)}) x WHERE x.can_read`;
}

/** SQL for the ids of the spaces `actor` may WRITE (a subquery body). */
export function writableSpaceIdsSql(actor: ActorCtx, params: unknown[]): string {
  return `SELECT x.space_id FROM (${spaceAccessSql(actor, params)}) x WHERE x.can_write`;
}

/** The ids of the spaces `actor` may write in. */
export async function writableSpaceIds(actor: ActorCtx): Promise<string[]> {
  const params: unknown[] = [];
  const r = await q<{ space_id: string }>(writableSpaceIdsSql(actor, params), params);
  return r.rows.map((row) => row.space_id);
}

/** What explainAccess needs to know about one agent in one space. */
export type AgentAccessFacts = {
  liveTokens: number;
  writeTokens: number;
  externalAi: boolean;
  /** The agent's permission in the space; null = not a member. */
  permission: SpacePermission | null;
};

/** The reasons behind the gate's answer. `gate` is what spaceAccessSql said for
 *  the same agent (a synthetic token whose access is write when any live token
 *  is); a reason is given only where the gate says no, so the explanation can
 *  never contradict the rule. The order here is the proposal's table. */
export function explainAccess(
  facts: AgentAccessFacts, gate: { read: boolean; write: boolean },
): { readBlockedBy: AccessBlock | null; writeBlockedBy: AccessBlock | null } {
  const readBlockedBy: AccessBlock | null = gate.read ? null
    : facts.liveTokens === 0 ? "no_live_token"
    : facts.permission === null ? "not_member"
    : !facts.externalAi ? "external_ai_off"
    : "not_member"; // unreachable while the gate and the facts agree
  const writeBlockedBy: AccessBlock | null = gate.write ? null
    : readBlockedBy ?? (facts.permission === "view" ? "view_only" : facts.writeTokens === 0 ? "token_read_only" : "view_only");
  return { readBlockedBy, writeBlockedBy };
}

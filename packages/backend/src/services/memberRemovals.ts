// Workspace member removal (GAP-237). Session actor resolution creates an actor
// the first time it sees a signed-in user, so deleting a member's actor alone
// was undone by their very next request (re-created as viewer, with read access
// to the workspace). The removal record, keyed by the login identity
// (actors.external_id = the auth user id), is what keeps them out.
//
// Contract:
//   • recordMemberRemoval / liftMemberRemoval run inside the caller's
//     transaction (q()), next to the actor delete / create they belong to.
//   • isMemberRemoved is read inside the actor-bootstrap lock, so a resolution
//     racing a removal sees either the actor row or the record, never neither.
//   • endUserSessions is best effort AFTER commit: the record already blocks
//     access; ending sessions only sends the browser back to the sign-in screen
//     instead of leaving it signed in to a workspace that answers 401.
import { q } from "../db.js";
import { auth } from "../auth.js";
import { log } from "../logger.js";

export async function recordMemberRemoval(workspaceId: string, externalId: string): Promise<void> {
  await q(
    `INSERT INTO member_removals (workspace_id, external_id) VALUES ($1, $2)
     ON CONFLICT (workspace_id, external_id) DO UPDATE SET removed_at = now()`,
    [workspaceId, externalId],
  );
}

/** An owner explicitly adding the person back lifts the removal. */
export async function liftMemberRemoval(workspaceId: string, externalId: string): Promise<void> {
  await q(`DELETE FROM member_removals WHERE workspace_id = $1 AND external_id = $2`, [workspaceId, externalId]);
}

export async function isMemberRemoved(workspaceId: string, externalId: string): Promise<boolean> {
  const r = await q(`SELECT 1 FROM member_removals WHERE workspace_id = $1 AND external_id = $2`, [workspaceId, externalId]);
  return r.rows.length > 0;
}

export async function endUserSessions(externalId: string): Promise<void> {
  try {
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUserSessions(externalId);
  } catch (err) {
    log.warn("memberRemovals", "could not end the removed member's sessions", { err });
  }
}

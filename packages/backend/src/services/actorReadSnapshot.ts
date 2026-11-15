import { inTransaction, withReadSnapshot } from "../db.js";
import { requireActor } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { resolveCurrentActor } from "../spine/currentActor.js";

/** Recheck an authenticated actor's current authority in the same snapshot as
 *  the reads performed by `read`. Use its callback actor for all read policies:
 *  withActorReadSnapshot(authenticated, ws, actor => readNotes(actor, ws)).
 *
 *  The input's actor/token IDs must come from trusted authentication, never a
 *  request body. Its earlier role, scopes and display fields are not authority.
 *  Missing actors, workspace mismatch, revoked/expired/mismatched tokens throw
 *  UnauthorizedError (401). Scope narrowing uses current allowlists; promotion
 *  and grants are also visible. Existing policy functions still decide access.
 *
 *  Reuses withReadSnapshot's no-nesting and q()-only contract. Later commits can
 *  affect the next request, not mix new content with this snapshot's authority.
 *  It does not reauthenticate a session cookie or refresh write-side authority. */
export function withActorReadSnapshot<T>(
  authenticated: ActorCtx | null,
  workspaceId: string,
  read: (actor: ActorCtx) => Promise<T>,
): Promise<T> {
  const identity = requireActor(authenticated);
  return withReadSnapshot(async () => read(await resolveCurrentActor(identity, workspaceId)));
}

/** withActorReadSnapshot for a read that an agent tool also runs. A tool called by an AI session runs inside the
 *  session's chain (callTool → runCascade): one transaction that holds the workspace's event lock, where a
 *  snapshot cannot start (withReadSnapshot refuses to be joined). There the read joins that transaction instead:
 *  the actor is re-read in it, and no write of this workspace can commit between its queries while the lock is
 *  held. Everywhere else it is withActorReadSnapshot. Not for sync responses: those must be a snapshot. */
export function withActorReadSnapshotOrChain<T>(
  authenticated: ActorCtx | null,
  workspaceId: string,
  read: (actor: ActorCtx) => Promise<T>,
): Promise<T> {
  if (!inTransaction()) return withActorReadSnapshot(authenticated, workspaceId, read);
  const identity = requireActor(authenticated);
  return (async () => read(await resolveCurrentActor(identity, workspaceId)))();
}

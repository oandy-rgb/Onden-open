// Handing the workspace to someone else — the ONE way ownership changes
// (roles proposal §3.5, decision 10).
//
// The owner is workspaces.owner_actor_id. The database refuses any other change
// to a set owner (migration 128: the row can only change inside a transaction
// that declares the new owner in `onden.owner_transfer`, which only this
// operation does), so a stray UPDATE, a deletion path or a future bug cannot
// leave the workspace ownerless and let anyone inherit it.
//
// Who may hand it over: the current owner's own login session. A delegated token
// can't (principal_admin), another member can't, and the native System account
// can only where the native bypass is on (it is the owner of a development
// install; in production nothing signs in as System). To whom: a person who has
// signed in — not an agent, not a pending invite, not System — typed back by
// name so a slip of the finger or a stale page cannot pick the wrong person.
//
// The previous owner stays a member, with every space seat they had.

import { q } from "../db.js";
import { mutate, requireActor } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { withIdempotencyClaim } from "../spine/idempotency.js";
import { isWorkspaceOwner } from "../spine/authority.js";
import { nativeBypassEnabled } from "../nativeBypass.js";
import type { ActorCtx } from "../types.js";
import { ActorAdminError } from "./actors.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { SYSTEM_EXTERNAL_ID } from "../spine/systemActor.js";

const OWNER_ONLY = new ActorAdminError(403, { error: "owner_only", detail: "only the workspace owner can hand the workspace to someone else" });

export async function transferOwnership(
  authenticated: ActorCtx | null, workspaceId: string, input: { toActorId: string; confirmName: string },
): Promise<{ ok: true; owner_id: string; previous_owner_id: string | null }> {
  const identity = requireActor(authenticated);
  if (identity.tokenScope) throw OWNER_ONLY; // before any lookup: a token learns nothing
  // The key is claimed first: a retry whose first answer was lost replays as
  // "done" (200 {deduped:true}) even though the caller is no longer the owner,
  // instead of meeting the owner check below. A claim made by a request that
  // then fails rolls back with it, so a refused attempt keeps no key.
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    await claim();
    const actor = await resolveCurrentActor(identity, workspaceId);
    if (!(await isWorkspaceOwner(actor))) throw OWNER_ONLY;
    const me = (await q<{ external_id: string | null }>(`SELECT external_id FROM actors WHERE id = $1`, [actor.id])).rows[0];
    if (me?.external_id === SYSTEM_EXTERNAL_ID && !nativeBypassEnabled()) throw OWNER_ONLY;

    const target = (await q<{ id: string; name: string; type: string; external_id: string | null }>(
      `SELECT id::text, name, type, external_id FROM actors WHERE id::text = $1 AND workspace_id = $2`,
      [input.toActorId, workspaceId])).rows[0];
    if (!target) throw new ActorAdminError(404, { error: "not_found", detail: "no such member" });
    const current = (await q<{ owner_actor_id: string | null }>(`SELECT owner_actor_id::text FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]?.owner_actor_id ?? null;
    if (target.id === current || target.id === actor.id) throw new ActorAdminError(409, { error: "already_owner" });
    if (target.type !== "human" || target.external_id === null || target.external_id === SYSTEM_EXTERNAL_ID) {
      throw new ActorAdminError(409, { error: "invalid_new_owner", detail: "the new owner must be a person who has signed in" });
    }
    if (input.confirmName !== target.name) {
      throw new ActorAdminError(400, { error: "confirm_name_mismatch", detail: "type the new owner's name exactly to confirm" });
    }

    await mutate({
      actor, workspaceId,
      authority: { kind: "principal_admin" },
      affectsMembership: true,
      event: {
        type: "WORKSPACE_OWNER_TRANSFERRED", targetType: "workspace", targetId: workspaceId,
        // Ids only: the log names who handed it to whom, nothing typed in.
        payload: { from_actor_id: current ?? actor.id, to_actor_id: target.id },
      },
      apply: async () => {
        // The declaration the database guard (migration 128) looks for, scoped to
        // this transaction.
        await q(`SELECT set_config('onden.owner_transfer', $1, true)`, [target.id]);
        await q(`UPDATE workspaces SET owner_actor_id = $2 WHERE id = $1`, [workspaceId, target.id]);
      },
    });
    return { ok: true as const, owner_id: target.id, previous_owner_id: current };
  }));
}

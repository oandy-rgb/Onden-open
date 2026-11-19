import { pool } from "../../db.js";

/** Fixture setup: make `actorId` the workspace owner (or, with null, leave it
 *  ownerless). The owner can change only inside a transaction that declares the
 *  new owner (migration 128, services/ownerTransfer.ts); this is that declaration
 *  for tests that need a particular owner without going through a transfer. */
export async function setWorkspaceOwner(workspaceId: string, actorId: string | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('onden.owner_transfer', $1, true)`, [actorId ?? "none"]);
    await client.query(`UPDATE workspaces SET owner_actor_id = $2 WHERE id = $1`, [workspaceId, actorId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Fixture teardown: delete every actor of these workspaces. The owner's actor
 *  row cannot be deleted while it is the owner (migration 128), so the owner is
 *  cleared first, the way an operator would. */
export async function deleteWorkspaceActors(workspaceIds: string | string[]): Promise<void> {
  const ids = Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds];
  for (const id of ids) await setWorkspaceOwner(id, null);
  await pool.query(`DELETE FROM actors WHERE workspace_id = ANY($1::uuid[])`, [ids]);
}

import { createContextSlot } from "../requestContext.js";
import { inTransaction, q, withTransaction } from "../db.js";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { afterRollback } from "./txHooks.js";
import { noteReplayedPosition, setClaimPositionRecorder } from "./eventPosition.js";

/** The key belongs to a committed operation. The HTTP boundary preserves the
 *  existing 200 {deduped:true} acknowledgement; this is not a second result. */
export class IdempotentReplay extends Error {
  constructor(public readonly key: string) {
    super("idempotent_replay");
    this.name = "IdempotentReplay";
  }
}

// A request may perform several sequential root writes (for example, ensuring
// the task tag then creating a task). They share one claim. A fresh request has
// a fresh holder and must prove its key was not committed by an earlier one.
type IdempotencyStore = { key: string; claimed: boolean };
const idempotency = createContextSlot<IdempotencyStore>();

export function withIdempotencyKey<T>(key: string, fn: () => T): T {
  return idempotency.run({ key, claimed: false }, fn);
}

/** Share the request claim with a transactional operation. The callback must
 *  encompass its transaction/savepoint, and call `claim()` inside that unit:
 *
 *    withIdempotencyClaim(ws, claim => withEventTransaction(ws, async () => {
 *      await claim();
 *      return apply();
 *    }));
 *
 *  The transaction/savepoint that acquires a claim owns its invalidation.
 *  Even after this wrapper returns, an enclosing rollback clears that cached
 *  claim. A failed child cannot clear a claim acquired before its savepoint.
 *  A caught exception without SQL rollback does not release a persisted claim.
 *  Domain failures must throw before the transaction completes.
 *
 *  An explicit key overrides the HTTP key; no key is a no-op. Calls sharing an
 *  ambient holder must be sequential. A lost COMMIT response invalidates the
 *  cached claim too; a retry asks the database whether it actually committed.
 */
export async function withIdempotencyClaim<T>(
  workspaceId: string,
  run: (claim: () => Promise<void>) => Promise<T>,
  explicitKey?: string,
): Promise<T> {
  const store = idempotency.getStore();
  const key = explicitKey ?? store?.key;
  const requestStore = store?.key === key ? store : undefined;

  const claim = async (): Promise<void> => {
    if (!key || requestStore?.claimed) return;
    if (!inTransaction()) throw new Error("idempotency claim requires a transaction");
    // The existing PK serializes concurrent requests. A loser waits for the
    // first transaction: COMMIT means replay; ROLLBACK makes its INSERT succeed.
    // q() binds this claim to the same transaction as the guarded state/event.
    const result = await q<{ key: string }>(
      `INSERT INTO idempotency_keys (key, workspace_id) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, workspaceId],
    );
    if (result.rowCount === 0) {
      // The first write committed (this INSERT waited for it): answer with ITS position, read now that it is visible.
      noteReplayedPosition((await committedIdempotencyKey(workspaceId, key))?.position ?? null);
      throw new IdempotentReplay(key);
    }
    if (requestStore) {
      requestStore.claimed = true;
      afterRollback(() => { requestStore.claimed = false; });
    }
  };

  return run(claim);
}

/** Spend the request's key without writing anything: for an operation that turned out to be a no-op (removing what was not
 *  there, setting a field to the value it has). Without it the key stays free, and a retry after a lost reply would run
 *  against newer state and undo someone else's change. Inside a transaction the claim commits or rolls back with it; outside
 *  one it gets its own. Already claimed by this request's write, or no key: nothing to do. */
export function spendIdempotencyKey(workspaceId: string): Promise<void> {
  return withIdempotencyClaim(workspaceId, (claim) => (inTransaction() ? claim() : withTransaction(claim)));
}

/** The request's claimed key keeps the last event its write inserted, in the same transaction (migration 212). A claim
 *  made with an explicit key (not the request's) is not the request's answer, so it keeps none. */
setClaimPositionRecorder(async (eventId) => {
  const store = idempotency.getStore();
  if (!store?.claimed || !inTransaction()) return;
  await db.updateTable("idempotency_keys")
    .set({ event_position: sql<string>`GREATEST(COALESCE(event_position, 0), ${eventId}::bigint)` })
    .where("key", "=", store.key).execute();
});

/** Has this workspace already COMMITTED a write under `key`? Read-only, for the HTTP boundary: a retry
 *  after a lost reply is acknowledged before any route state check (note still exists? already live?)
 *  can refuse it. A first request still in flight has not committed its claim, so it is not visible here
 *  and falls through to the in-transaction claim above, which stays the source of truth. A key that
 *  belongs to another workspace is indistinguishable from an unknown one. `position` is the event its write committed
 *  at (null: none, or a key from before migration 212); the replay answers with it. */
export async function committedIdempotencyKey(workspaceId: string, key: string): Promise<{ position: string | null } | null> {
  const row = await db.selectFrom("idempotency_keys").select("event_position")
    .where("key", "=", key).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return row === undefined ? null : { position: row.event_position === null ? null : String(row.event_position) };
}

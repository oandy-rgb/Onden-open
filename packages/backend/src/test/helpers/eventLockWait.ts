import { setTimeout as pause } from "node:timers/promises";
import type { PoolClient } from "pg";

/**
 * Wait until some other connection is blocked on THIS workspace's event lock
 * (`event-append:<workspaceId>`, see spine/eventTransaction.ts), then return.
 *
 * Match the lock by its key. `NOT granted` on any advisory lock also matches a
 * waiter from another file's leftover background work in the shared test
 * database; the test then changed authority before its own writer was queued
 * and saw a different refusal, so it failed only when the whole suite ran.
 * The key is `pg_advisory_xact_lock(bigint)`: classid is the high 32 bits and
 * objid the low 32 bits of `hashtext(...)::bigint`.
 * `waiters`: how many connections must be queued — Postgres grants a contended lock in the order it was asked for, so a test that starts
 * one writer, waits for it to queue, then starts a second and waits for two, fixes which of them gets the lock first.
 */
export async function waitForEventLockWaiter(blocker: PoolClient, workspaceId: string, attempts = 500, waiters = 1): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const waiting = await blocker.query(
      `SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND objsubid=1
          AND ((classid::bigint << 32) | objid::bigint) = hashtext($1)::bigint`,
      [`event-append:${workspaceId}`]);
    if (waiting.rows.length >= waiters) return;
    await pause(10);
  }
  throw new Error("writer never queued on the workspace event lock");
}

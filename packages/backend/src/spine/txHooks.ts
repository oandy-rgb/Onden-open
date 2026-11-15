// Transaction outcome hooks — ALS-scoped queues for commit and rollback.
//
// Realtime ticks and the instant outbox drain must fire AFTER the surrounding
// transaction commits, never inside it: a tick for a rolled-back event would
// make clients refetch nothing (harmless) but a drain inside the tx would try
// to perform an effect whose intent row isn't visible yet (it reads via a
// different connection), and a tick emitted mid-tx could race the commit.
//
// db.withTransaction() owns the scope through SQL commit / rollback. Released
// savepoints transfer both queues to their parent: release is not durability.
// Outside any transaction
// (plain autocommit queries) afterCommit() runs the callback immediately —
// the statement is already durable by the time the await returns.
//
// Deliberately its own module (not part of db.ts): services like outbox.ts
// import afterCommit() directly, and unit tests that mock ../db.js keep the
// real (trivially-immediate) behaviour instead of crashing on a missing mock.

import { createContextSlot } from "../requestContext.js";
import { log } from "../logger.js";

type HookScope = { commit: Array<() => void>; rollback: Array<() => void> };
const storage = createContextSlot<HookScope>();

function runHooks(callbacks: Array<() => void>, outcome: "commit" | "rollback"): void {
  for (const callback of callbacks) {
    try { callback(); } catch (error) { log.error("txHooks", `after-${outcome} hook failed`, { err: error }); }
  }
}

/** Run `fn` after the enclosing transaction commits; immediately if there is
 *  no enclosing withTransaction(). Hooks are fire-and-forget: a throwing hook
 *  is logged, never propagated (it must not fail the committed mutation). */
export function afterCommit(fn: () => void): void {
  const scope = storage.getStore();
  if (scope) scope.commit.push(fn);
  else runHooks([fn], "commit");
}

/** Invalidate transaction-dependent memory when this unit or an enclosing unit
 * fails, after SQL cleanup has been attempted. Commit may be unconfirmed, so
 * this is not proof that a durable write is absent: retry must check storage.
 * Callbacks must be synchronous, local invalidation, not compensating writes.
 * Outside a transaction there is nothing to roll back; the callback is ignored.
 *
 * afterRollback(() => { cachedClaim = false; })
 */
export function afterRollback(fn: () => void): void {
  storage.getStore()?.rollback.push(fn);
}

/** For transaction owners only: fn must include BEGIN/SAVEPOINT, the work,
 * COMMIT/RELEASE and error cleanup. A successful child transfers BOTH queues to
 * its parent; root success runs commit hooks. Failure invalidates this unit in
 * reverse registration order before propagating, never running success hooks.
 * Hook failures are logged and cannot replace the transaction result/error.
 */
export async function withTxHookScope<T>(fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const scope: HookScope = { commit: [], rollback: [] };
  let result: T;
  try {
    result = await storage.run(scope, fn);
  } catch (error) {
    runHooks(scope.rollback.reverse(), "rollback");
    throw error;
  }
  if (parent) {
    parent.commit.push(...scope.commit);
    parent.rollback.push(...scope.rollback);
  } else runHooks(scope.commit, "commit");
  return result;
}

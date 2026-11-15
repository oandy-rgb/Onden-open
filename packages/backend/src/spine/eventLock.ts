/** The per-workspace lock that orders domain_events ids by commit. /api/sync
 *  acknowledges the last id it scanned, so an id committed after a higher one
 *  would be skipped forever. The one definition of the key: db.ts event() and
 *  spine/eventTransaction.ts lockEventAppend() (used by mutate.ts) both take it.
 *  Writers acquire it before changing state. This file imports no module that
 *  reaches db.ts (config, logger and statusError are leaves), so db.ts can use it without an
 *  import cycle (and tests that mock db.js keep the real lockEventAppend, which
 *  only needs the mocked q). */
import { config } from "../config.js";
import { CodedStatusError } from "../statusError.js";
import { log } from "../logger.js";

export const EVENT_APPEND_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))";
export const eventAppendLockKey = (workspaceId: string): string => `event-append:${workspaceId}`;

/** The writer waited longer than the lock-wait limit for another write on the
 *  same workspace. Nothing was written; the same request can be sent again.
 *  httpError.ts answers 503 `workspace_busy` with Retry-After. */
export class WorkspaceBusyError extends CodedStatusError {
  constructor(readonly retryAfterSeconds: number) {
    super(503, "workspace_busy", "Another change to this workspace is still being saved");
  }
}

/** How long a write waits for the workspace lock before giving up (0 = no limit of its own,
 *  only statement_timeout applies). Read per call: tests and operators change the env. */
const lockWaitMs = (): number => config.int("ONDEN_WRITE_LOCK_WAIT_MS", 5_000);

/** Take the workspace lock with its own, shorter wait limit. The limit covers only this
 *  one statement: it is put back before the next one, so later statements and row locks
 *  (FOR UPDATE) keep the connection's normal limits. A timeout (55P03) that comes from
 *  THIS statement becomes WorkspaceBusyError; statement_timeout (57014) is not touched.
 *  `run` is the caller's transaction-bound query function (db.ts q). */
export async function acquireEventAppendLock(
  run: (text: string, params: unknown[]) => Promise<unknown>,
  workspaceId: string,
): Promise<void> {
  const waitMs = lockWaitMs();
  const lock = () => run(EVENT_APPEND_LOCK_SQL, [eventAppendLockKey(workspaceId)]);
  if (waitMs <= 0) { await lock(); return; }
  await run("SELECT set_config('lock_timeout', $1, true)", [`${waitMs}ms`]);
  const started = Date.now();
  try {
    await lock();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "55P03") {
      log.warn("write-lock", "gave up waiting for the workspace write lock", { workspaceId, waitedMs: Date.now() - started });
      throw new WorkspaceBusyError(Math.max(1, Math.ceil(waitMs / 1000)));
    }
    throw err;
  }
  // Back to the connection's own limit (not a remembered value): nothing else sets lock_timeout.
  await run("SET LOCAL lock_timeout TO DEFAULT", []);
}

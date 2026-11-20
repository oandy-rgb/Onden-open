import { serve } from "@hono/node-server";
import { loadWorkspaceClock, startWorkspaceClockReload } from "./services/workspaceTime.js";
import { DatabaseNewerThanCodeError, getWorkspaceId, migrate, pruneEvents, pool } from "./db.js";
import { log } from "./logger.js";
import { config, isTest } from "./config.js";
import { startPeriodicJob } from "./backgroundJobs.js";
import { startOutboxReconciler } from "./services/outbox.js";
import { repairBlockMarkers } from "./services/blockMarkerRepair.js";
import { indexMissingNoteLinks } from "./services/wikilinkEdges.js";
import { setRateLimiter, PgRateLimiter } from "./services/agentTools/index.js";
import { startDispatcherCatchup } from "./services/dispatcherQueue.js";
import { initGit } from "./git.js";
import { auth } from "./auth.js";
import { backfillModuleImports, startModuleBackground } from "./modules/index.js";
import { failInterruptedRestoreJobs } from "./services/backupRestoreJobs.js";
import { expireOverdue } from "./services/agentSessions.js";
import { failInterruptedApiSessions } from "./services/agentRuntime/index.js";
import { resealLegacyApiKeys } from "./services/aiCredentials.js";
import { app } from "./app.js";

// Node boot (the `npm start` / `npm run dev` entry). The assembled app is in
// app.ts; this file adds what only a Node server does: migrations, background
// jobs, the listening port. Importing app.ts alone starts none of it.
export { app };

// Skipped under NODE_ENV=test so a test importing this file does not bind a port or migrate.
if (!isTest()) {
  const port = config.int("PORT", 8787);
  // A stray rejected promise (fire-and-forget housekeeping such as
  // `void pruneEvents()`) must not take every open request and SSE stream
  // down with it. Log it so it can be fixed where it starts.
  process.on("unhandledRejection", (reason) => {
    log.error("process", "unhandled promise rejection", { err: reason });
  });
  try {
    await migrate();
  } catch (e) {
    if (!(e instanceof DatabaseNewerThanCodeError)) throw e;
    // Plain wording on purpose: the person reading this is a self-hoster who just rolled back an image.
    log.error("migrate", "資料庫比這個版本新，後端不會啟動，以免舊程式寫壞新資料。"
      + "請升級回去（scripts/upgrade.sh <較新的版本>），或用 scripts/rollback.sh（內部呼叫 scripts/restore.sh）還原升級前的備份。"
      + "（this version does not know migrations: " + e.unknownVersions.join(", ") + "）");
    process.exit(1);
  }
  // Before anything asks what day it is (the task scheduler, the first request).
  {
    const workspaceId = await getWorkspaceId();
    await loadWorkspaceClock(workspaceId);
    startWorkspaceClockReload(workspaceId);
  }
  await (await auth.$context).runMigrations();
  // First library run: pre-library workspaces import what they already use.
  await backfillModuleImports();
  // Not awaited: until a note is indexed, relinking reads its text instead.
  void indexMissingNoteLinks().catch((err) => log.warn("wikilink", `note link index backfill failed: ${err instanceof Error ? err.message : String(err)}`));
  // Not awaited: an API key saved before its purpose was authenticated still opens until it is resealed (services/serverSecret.ts).
  void resealLegacyApiKeys().catch((err) => log.warn("secrets", `API key reseal failed: ${err instanceof Error ? err.message : String(err)}`));
  await initGit();
  // Restore jobs live in this process only: a running one is from a process
  // that is gone (services/backupRestoreJobs.ts). Before serving.
  await failInterruptedRestoreJobs();
  // domain_events is append-only by default (migration 051): nothing is ever
  // deleted. The snapshot-gated prune ("mode X") — which GCs only un-snapshotted
  // human edit-churn while keeping every agent action and every checkpoint
  // forever — is EXPERIMENTAL and opt-in.
  if (config.is("EVENT_PRUNE_EXPERIMENTAL", "on")) {
    log.info("prune", "EXPERIMENTAL snapshot-gated event pruning enabled (EVENT_PRUNE_EXPERIMENTAL=on)");
    startPeriodicJob({ name: "prune-events", everyMs: 24 * 60 * 60 * 1000, runFirstAfterMs: 0 }, pruneEvents);
  }
  // idempotency_keys housekeeping: migration 064 promises rows are "prunable
  // after a generous window — the queue never retries across weeks", but nothing
  // ever deleted them, so the table grew unbounded. GC keys older than 30 days
  // (well beyond any offline-drain replay window) daily.
  const pruneIdempotencyKeys = async (): Promise<void> => {
    try {
      const r = await pool.query(
        `DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days'`,
      );
      if (r.rowCount) log.info("prune", `removed ${r.rowCount} expired idempotency key(s)`);
    } catch (e) {
      log.error("prune", "idempotency_keys gc failed", { err: e });
    }
  };
  startPeriodicJob({ name: "prune-idempotency-keys", everyMs: 24 * 60 * 60 * 1000, runFirstAfterMs: 0 }, pruneIdempotencyKeys);
  // Agent sessions past their deadline fail with timed_out (a runner that
  // vanished must not leave the note's chip spinning). Every minute.
  const sweepAgentSessions = async (): Promise<void> => {
    try {
      const ended = await expireOverdue();
      if (ended) log.info("agent-sessions", `timed out ${ended} session(s)`);
      // An api session this process is not running died with its process: failed, never re-run (it would pay twice).
      const interrupted = await failInterruptedApiSessions();
      if (interrupted) log.info("agent-sessions", `${interrupted} api session(s) interrupted`);
    } catch (e) {
      log.error("agent-sessions", "timeout sweep failed", { err: e });
    }
  };
  startPeriodicJob({ name: "sweep-agent-sessions", everyMs: 60 * 1000, runFirstAfterMs: 0 }, sweepAgentSessions);
  // Multi-replica: install the shared (pg-backed) rate limiter so a token's limit
  // is enforced ACROSS instances, not N× per replica. Opt-in via RATE_LIMIT_BACKEND
  // =pg; the default in-memory limiter stays for single-instance deployments.
  if (config.is("RATE_LIMIT_BACKEND", "pg")) {
    setRateLimiter(new PgRateLimiter());
    log.info("rate-limit", "using shared pg-backed limiter (cross-instance)");
  }
  // Drain the transactional outbox (durable git/GitHub backup effects).
  startOutboxReconciler();
  // M1: replay tag-behaviour cascades a previous process crashed out of
  // (dispatcher_pending intents whose settle never ran), then keep a slow
  // backstop interval. Must come after migrate() — it reads migration 065's
  // table.
  startDispatcherCatchup();
  // Module background loops (e.g. the RSS due-source sweep, which files
  // rss_fetch outbox intents for the reconciler above to perform; the tasks
  // module's D8 time-trigger that rolls unattended recurring tasks forward).
  startModuleBackground();
  // Puts back a tagged paragraph's row when typed-under text left its `{…} ^id` mid-paragraph, then moves every
  // remaining `^id` out of the notes' text into anchors (services/blockMarkerRepair.ts, blockIdMigration.ts).
  // First run soon after boot: until a note is converted its marks show as text.
  startPeriodicJob({ name: "block-marker-repair", everyMs: 6 * 60 * 60 * 1000, runFirstAfterMs: 5_000, exclusive: true }, async () => { await repairBlockMarkers(); });
  const hostname = config.listenHost();
  serve({ fetch: app.fetch, port, hostname });
  log.info("boot", `Onden backend listening on ${hostname ?? "all interfaces"}:${port}`);
}

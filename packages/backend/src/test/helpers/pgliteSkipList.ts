// The tests a run is allowed to skip, per database driver, and nothing else (scripts/lib/skipGateReporter.mjs).
// "file": N means exactly N tests in that file skip on that driver; fewer or more fails the run, so the list is the
// whole truth and can only shrink (`// ratchet:list`, scripts/ratchetLib.mjs).
//
// PGLITE_SKIPS: the tests named `needsSecondConnection`, `needsPostgresServer` or `needsPgroonga` (helpers/pgliteSkips.ts),
// and the ones that are Postgres-only by their own condition. They are covered by `npm run test:real-pg`.
// POSTGRES_SKIPS: tests that mean something only on PGlite and skip on a real Postgres.
//
// To add a skip: you probably should not. If a test cannot mean the same thing on PGlite, say why in its name, add the
// file here, and say in the PR description why; to remove one, delete or lower its line.

// ratchet:list pglite-skips
export const PGLITE_SKIPS: Readonly<Record<string, number>> = {
  "src/test/actorSnapshot.integration.test.ts": 1,
  "src/test/actorWriteAuthority.integration.test.ts": 6,
  "src/test/backupRestoreConcurrency.integration.test.ts": 6,
  "src/test/backupSnapshot.integration.test.ts": 1,
  "src/test/blobGcGrace.integration.test.ts": 1,
  "src/test/bootstrapSnapshot.integration.test.ts": 3,
  "src/test/coreConsistency.integration.test.ts": 7,
  "src/test/createNodeAuthority.integration.test.ts": 12,
  "src/test/dbDriver.integration.test.ts": 1,
  "src/test/eventTransaction.integration.test.ts": 2,
  "src/test/genesisStampsMigration.integration.test.ts": 1, // a write on a second connection while the migration is open; runs on real Postgres
  "src/test/idempotencyRollback.integration.test.ts": 1,
  "src/test/migration.integration.test.ts": 1,
  "src/test/nodeEventMeta.integration.test.ts": 1,
  "src/test/outbox.integration.test.ts": 1,
  "src/test/outboxLongrun.integration.test.ts": 1,
  "src/test/ownerMemberMigration.integration.test.ts": 16,
  "src/test/properties/backupHostHop.property.test.ts": 1,
  "src/test/properties/searchUnicode.integration.property.test.ts": 3,
  "src/test/readSnapshot.integration.test.ts": 1,
  "src/test/reviewTagModules.integration.test.ts": 2,
  "src/test/scale.integration.test.ts": 2,
  "src/test/schedulerLeaderLock.integration.test.ts": 1,
  "src/test/stampedPersonalWrites.integration.test.ts": 2,
  "src/test/syncEventOrdering.integration.test.ts": 1,
  "src/test/syncSnapshot.integration.test.ts": 6,
  "src/test/syncStamps.integration.test.ts": 2,
  "src/test/syncStampsS2Locks.integration.test.ts": 2,
  "src/test/syncStampsS3Locks.integration.test.ts": 2,
  "src/test/tagMembershipAuthority.integration.test.ts": 10,
  "src/test/tasksIntoFunctionRefsMigration.integration.test.ts": 1,
  "src/test/workspaceTime.integration.test.ts": 1,
  "src/test/writeLockWait.integration.test.ts": 2,
};

// ratchet:list postgres-skips
export const POSTGRES_SKIPS: Readonly<Record<string, number>> = {
  "src/test/distributedSyncCapture.integration.test.ts": 3, // PGlite-only by its own condition since 2026-11-06
  "src/test/distributedSyncOff.test.ts": 1,
  "src/test/distributedSyncReal.integration.test.ts": 7, // two in-process PGlite backends; no second real server
  "src/test/distributedSyncRealSim.integration.test.ts": 4, // the same two PGlite backends under random activity
  "src/test/distributedSyncScale.integration.test.ts": 1, // cost at size, measured on PGlite
  "src/test/poolQueryInTransaction.test.ts": 2,
  "src/test/replicatedOpBoundary.integration.test.ts": 2,
  // Two in-process PGlite databases (a stamped snapshot copied to an empty one); no second real server. The round trip itself and the
  // refusals of a damaged copy run on real Postgres in stampedSnapshotTwoProcess.integration.test.ts (one database per process: digest,
  // rows and stamps, the system space and Site Config, unstamped rows, POST/GET /api/snapshot, eight damaged copies). What stays here,
  // 29 tests; each, and why it is not there too:
  //   same digest / same row by row (2), bootstrap counts of both nodes (1): the two-process file checks the first two on real Postgres;
  //     they stay for the shuffled PGlite run, and the third reads the receiver as a second node next to the source;
  //   the checks notice a tampered receiver (1), a done database's counts (1), the receiver goes on as a node of its own (1), the
  //     sign-in link (1), a limited reader's copy (1), "not a copy of what the owner cannot read" (1): source and receiver open at once,
  //     or the receiver written to afterwards;
  //   the packaged browser database as receiver (1): PGlite's own tar;
  //   refusals that prepare the receiver by hand before the join: not empty (1) and "someone already wrote" (1), which kind and System-account stamps (1), the known limit of
  //     "empty" (1), cancel (1), a cut-off join (1), a stamp naming this node (1), a clock ahead with the clock checked after (1),
  //     page replay (1), order inside and across pages (1), write while joining (1), person must be human (1), triggers step aside only
  //     inside a join (1), a foreign origin and the other malformed pages (1), "refuses what is not done, and a token" (1);
  //   the routes: hello/pages/manifest (1), 403 for a non-owner (1), upload fills the empty database (1), malformed lines (1): the same
  //     routes are called on real Postgres in the two-process file; these keep the two-node variants.
  "src/test/stampedSnapshot.integration.test.ts": 29,
  "src/test/properties/stampedSnapshot.property.integration.test.ts": 1, // the same two databases under random writes
};

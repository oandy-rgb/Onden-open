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
  "src/test/properties/searchPrefix.metamorphic.integration.test.ts": 4, // the pgroonga engine's two metamorphic relations, its fixed whole-token example and its differential against the portable engine; real Postgres runs them
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
  "src/test/browserBringNotes.integration.test.ts": 1, // the browser version's own database is PGlite: the file it takes in is only that copy's (#1756)
  "src/test/distributedSyncCapture.integration.test.ts": 3, // PGlite-only by its own condition since 2026-11-06
  "src/test/distributedSyncOff.test.ts": 1,
  "src/test/distributedSyncReal.integration.test.ts": 7, // two in-process PGlite backends; no second real server
  "src/test/distributedSyncRealSim.integration.test.ts": 4, // the same two PGlite backends under random activity
  "src/test/distributedSyncScale.integration.test.ts": 1, // cost at size, measured on PGlite
  "src/test/poolQueryInTransaction.test.ts": 2,
  "src/test/replicatedOpBoundary.integration.test.ts": 2,
};

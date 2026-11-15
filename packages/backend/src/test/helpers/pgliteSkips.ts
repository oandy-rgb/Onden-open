// Tests that cannot mean the same thing on PGlite (ONDEN_DB_DRIVER=pglite) say so by name, with the
// reason in the name, instead of passing vacuously or being dropped from the run:
//
//   it.skipIf(needsSecondConnection)("refuses the writer after waiting for the event lock", …)
//
// All three are true only on PGlite; on real Postgres every test runs. `grep -rn "needs[A-Z]" src/test`
// lists them; the PR description counts them.

const onPglite = process.env.ONDEN_DB_DRIVER === "pglite";

/** The test holds one transaction open and runs another on a second connection (lock waits, "queued
 *  writer", cross-connection snapshots, advisory lock held elsewhere). PGlite has one connection. */
export const needsSecondConnection = onPglite;
/** The test is about the Postgres server itself: its own `pg` connection, statement_timeout, pool
 *  connection counts, connection eviction; or it seeds tens of thousands of rows (scale), which PGlite runs for an hour. */
export const needsPostgresServer = onPglite;
/** The test pins pgroonga's tokenizer or operator (`&@~`) or its Unicode folding; the portable
 *  engine's differences are listed in docs/architecture/portable-backend.md. */
export const needsPgroonga = onPglite;

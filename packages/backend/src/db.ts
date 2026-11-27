import { createContextSlot, currentDeviceId } from "./requestContext.js";
import pg from "pg";
import { PglitePool, asPgPool, type PoolClientLike } from "./dbPglite.js";
import { nodeBuiltin } from "./nodeBuiltins.js";
import { listMigrations, portableMigrationSql } from "./dbMigrations.js";
import { afterCommit, withTxHookScope } from "./spine/txHooks.js";
import { replayedOpId } from "./spine/replicatedOp.js";
import { log } from "./logger.js";
import { closeDatabase } from "./dbClose.js";
import { translateUnitInConflict } from "./spine/unitInConflict.js";
import { EVENT_APPEND_LOCK_SQL, acquireEventAppendLock } from "./spine/eventLock.js";
import { noteInsertedEvent } from "./spine/eventPosition.js";
import { notifyChanged, notifyMembershipChanged } from "./services/realtime.js";
import { nativeBypassEnabled } from "./nativeBypass.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "./spine/systemActor.js";
import { config } from "./config.js";
import { DERIVED_ID_NAMESPACE, derivedIdName } from "@onden/markdown";
import { atDoubling, uuidV5 } from "./utils.js";
import { coreTableWritten, refusedOutsideTransaction, stampedTableWritten } from "./coreWriteSql.js";

const { Pool } = pg;

/** Which engine runs this process: real Postgres (a server; the default) or PGlite (Postgres in
 *  WASM: the desktop app, the browser app, tests without a server). ONDEN_DB_DRIVER=pglite picks
 *  it; ONDEN_PGLITE_DIR names where it keeps its files (default memory://). Everything above
 *  db.ts sees the same `pool`, `q()` and `withTransaction()`. */
export type DbDriver = "postgres" | "pglite";
export const dbDriver: DbDriver = config.is("ONDEN_DB_DRIVER", "pglite") ? "pglite" : "postgres";

function createPostgresPool(): pg.Pool {
  return new Pool({
    connectionString:
      config.str("DATABASE_URL") ??
      "postgres://onden:onden@localhost:5432/onden",
    // Session settings:
    //   • jit=off — Postgres JIT-compiles a query whose ESTIMATED cost passes
    //     jit_above_cost, and the estimate grows with the whole table, not with
    //     the rows a workspace-scoped query touches. The read-policy and export
    //     queries (correlated EXISTS per note) crossed it once the database held
    //     ~13k notes: 1.2–2.4 s of compiling for 37 ms of work. Short OLTP
    //     queries never win back a compile, so it is off for the app's sessions.
    //   • statement_timeout — a request's statement that runs longer than this is
    //     cancelled (SQLSTATE 57014) instead of holding one of the 20 pooled
    //     connections until the pool is exhausted and every request fails. Work
    //     that legitimately runs longer opts out for its own transaction:
    //     migrate() (SET LOCAL statement_timeout = 0). PG_STATEMENT_TIMEOUT_MS=0
    //     turns it off.
    //   • TimeZone=UTC — sessions never carry the workspace's zone: it is a
    //     setting the owner changes at run time, and a pooled connection would
    //     keep the old one. Day arithmetic names the zone and the day-start hour
    //     itself (localDay.ts sql* helpers), so nothing depends on this beyond
    //     being fixed.
    options: ["-c jit=off", `-c statement_timeout=${config.int("PG_STATEMENT_TIMEOUT_MS", 15_000)}`, "-c TimeZone=UTC"].join(" "),
    // Throughput headroom for concurrent writes (pg's default is 10).
    max: config.int("PG_POOL_MAX", 20, { min: 1 }),
    // Fail fast instead of hanging forever when the pool is genuinely saturated.
    // Without this, a request that can't get a connection waits indefinitely —
    // turning transient back-pressure into a wedge. 10s lets a real burst drain
    // while still surfacing an error if something is actually stuck.
    connectionTimeoutMillis: config.int("PG_CONNECT_TIMEOUT_MS", 10_000),
  });
}

/** The database handle of a PGlite process (undefined on Postgres): the desktop and browser
 *  hosts dump or sync it, tests restore a snapshot into it. */
export const pglite: PglitePool | undefined = dbDriver === "pglite" ? createPglitePool() : undefined;

let snapshotSource: (() => Promise<Blob | undefined>) | undefined;
/** A host without a file system (the browser worker) hands the database its starting point:
 *  the pre-migrated snapshot on a first open, or its own saved copy on later ones. Answering
 *  undefined starts an empty database. Call before the first query. */
export function useDatabaseSnapshot(next: () => Promise<Blob | undefined>): void {
  snapshotSource = next;
}

/** ONDEN_PGLITE_SNAPSHOT=<tar from dumpDataDir()>: start from a migrated database instead of an empty one
 *  (the test suite builds one once; a desktop build can ship one). useDatabaseSnapshot() wins. */
function pgliteSnapshot(): () => Promise<Blob | undefined> {
  return async () => {
    if (snapshotSource) return snapshotSource();
    const file = config.str("ONDEN_PGLITE_SNAPSHOT");
    if (!file) return undefined;
    const fs = nodeBuiltin<typeof import("node:fs/promises")>("node:fs/promises");
    if (!fs) throw new Error("ONDEN_PGLITE_SNAPSHOT needs a file system");
    return new Blob([await fs.readFile(file)]);
  };
}

function createPglitePool(): PglitePool {
  return new PglitePool({
    dataDir: config.str("ONDEN_PGLITE_DIR") || "memory://",
    loadDataDir: pgliteSnapshot(),
    connectTimeoutMs: config.int("PG_CONNECT_TIMEOUT_MS", 10_000),
    ambientClient: () => txStorage.getStore() as unknown as PoolClientLike | undefined,
    onPoolQueryInTransaction: refusePoolQueryInTransaction,
  });
}

export const pool: pg.Pool = pglite ? asPgPool(pglite) : createPostgresPool();

const endPool = pool.end.bind(pool) as () => Promise<void>;
let ending: Promise<void> | null = null;
pool.end = (() => {
  ending ??= closeDatabase(endPool);
  return ending;
}) as typeof pool.end;

// When Postgres restarts, every IDLE pooled client gets "terminating connection
// due to administrator command" and the pool re-emits it as 'error'. With no
// listener Node treats that as an uncaught exception and the whole backend
// exits (GAP-253). The pool has already discarded the broken client and the
// next query opens a fresh connection, so logging is all that is needed;
// queries issued during the outage still fail and surface as request errors.
pool.on("error", (err) => {
  log.error("db", "idle connection lost; the pool will reconnect", { err });
});

// ── Transaction context ─────────────────────────────────────────────────────
// `withTransaction` runs its callback inside a single PG client with BEGIN /
// COMMIT around it. Helpers in the call chain use `q()` instead of pool.query
// directly: if they're inside a withTransaction, q() uses the bound client;
// otherwise it falls back to the pool. ROLLBACK on any throw — leaves no
// "half-applied" dispatcher cascade behind.
//
// Implementation note: we use AsyncLocalStorage rather than thread-the-client
// because event() and dispatcher helpers are deep in the call chain and would
// otherwise need their signatures changed at every call site (~20+ places).

const txStorage = createContextSlot<pg.PoolClient>();

// QueryResult mirrors the relevant subset of pg's QueryResult — narrow enough
// to use without pulling in pg's QueryResultRow constraint at every call site.
type QueryResult<T> = { rows: T[]; rowCount: number | null };

/** Transactions that have taken the workspace event lock: mutate() and
 *  withEventTransaction() always do, before their first state change. */
const eventLockedClients = new WeakSet<object>();

/** Transactions that carry this node's write stamp (spine/stamps.ts), made by the one write entry
 *  (mutate, mutatePersonal, runCascade, runRestore). */
const stampedClients = new WeakSet<object>();
export function markTransactionStamped(): void {
  const tx = txStorage.getStore();
  if (tx) stampedClients.add(tx);
}

// Tests (vitest.config sets ONDEN_FORBID_UNSTAMPED_WRITES): a write to a stamped personal table (coreWriteSql.ts
// STAMPED_ENTRY_TABLES) outside a transaction the write entry stamped throws. The few writes that must stay outside
// say so with allowUnstampedWrite(), whose uses test/guards/stampedWrites.guard.test.ts counts (shrink-only).
const forbidUnstampedWrites = config.is("ONDEN_FORBID_UNSTAMPED_WRITES", "1");
const unstampedWriteAllowed = createContextSlot<string>();

/** Run `fn` whose writes to stamped personal tables are KNOWN not to go through the write entry. `reason` says why
 *  (it is the reader's only explanation); each use is listed in the PR that adds it and in stampedWrites.guard.test.ts. */
export function allowUnstampedWrite<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(unstampedWriteAllowed.run(reason, fn));
}

type CoreWriteWithoutEventLockObserver = (table: string) => void;
let coreWriteWithoutEventLockObserver: CoreWriteWithoutEventLockObserver | null = null;

/** Report-only (tests): called for a core-table write inside a transaction that
 *  never took the event lock, i.e. a plain withTransaction() that bypasses
 *  mutate()/withEventTransaction(). Nothing is blocked. Pass null to stop. */
export function observeCoreWritesWithoutEventLock(observer: CoreWriteWithoutEventLockObserver | null): void {
  coreWriteWithoutEventLockObserver = observer;
}

// Tests (vitest.config sets ONDEN_FORBID_POOL_QUERY_IN_TRANSACTION): a pool.query() made while the
// caller is inside a transaction throws. On real Postgres that query takes ANOTHER connection and
// cannot see the transaction's uncommitted rows; PGlite has one connection and silently answers
// from the transaction, so the mistake stays green in cloud tests. Read with q(); a write that
// must commit on its own connection goes through queryOnSeparateConnection().
const forbidPoolQueryInTransaction = config.is("ONDEN_FORBID_POOL_QUERY_IN_TRANSACTION", "1");
let separateConnectionQuery = false;

function refusePoolQueryInTransaction(text: string): void {
  if (!forbidPoolQueryInTransaction || separateConnectionQuery) return;
  throw new Error(`pool.query() inside a transaction: use q() to read in it, or queryOnSeparateConnection() to commit apart from it. SQL: ${text.replace(/\s+/g, " ")}`);
}

/** A query that is MEANT to commit on its own connection, apart from the caller's open transaction
 *  (blobs.putBlob: it must not hold a row lock until a long import commits). Not for reads: on real
 *  Postgres it cannot see the transaction's uncommitted rows (PGlite runs it on the transaction's
 *  connection; `separateConnectionQuery` is read synchronously by PglitePool.query before its first await). */
export function queryOnSeparateConnection<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  separateConnectionQuery = true;
  try {
    return pool.query<T>(text, params);
  } finally {
    separateConnectionQuery = false;
  }
}

export async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const tx = txStorage.getStore();
  if (tx && text === EVENT_APPEND_LOCK_SQL) eventLockedClients.add(tx);
  if (!tx || (coreWriteWithoutEventLockObserver && !eventLockedClients.has(tx))) {
    const table = coreTableWritten(text);
    if (table) {
      if (tx) coreWriteWithoutEventLockObserver?.(table);
      else if (refusedOutsideTransaction(table)) throw new Error(`q() writes ${table} outside a transaction; core writes must go through mutate() or withEventTransaction() (event + authority + one transaction)`);
    }
  }
  if (forbidUnstampedWrites && !(tx && stampedClients.has(tx)) && !unstampedWriteAllowed.getStore()) {
    const table = stampedTableWritten(text);
    if (table) throw new Error(`q() writes ${table} outside a stamped transaction; stamped personal data goes through mutatePersonal() or mutate() (spine/mutate.ts)`);
  }
  const result = tx
    ? await tx.query<T>(text, params)
    : await pool.query<T>(text, params);
  return { rows: result.rows, rowCount: result.rowCount };
}

export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  // Reentrant: if we're already inside a transaction, JOIN it — reuse the bound
  // client and run inline, no fresh pool.connect() and no nested BEGIN/COMMIT.
  // Opening a second connection here while the outer transaction still holds
  // its client is what deadlocked the pool under concurrent writes: every
  // request held one connection inside its mutate() transaction and then called
  // syncBlockIds (→ withTransaction), each waiting for a second connection that
  // never freed because all of them were held by the outer transactions. With
  // the pool saturated and no connectionTimeoutMillis, the backend wedged.
  // Joining the outer transaction is also the correct atomicity — the inner
  // work commits or rolls back as one unit with its caller.
  if (txStorage.getStore()) return fn();

  const bulk = bulkWrites.getStore();
  if (!bulk) return runTransaction("BEGIN", fn);
  bulk.transactions += 1;
  return runTransaction(`BEGIN; ${PLAN_FOR_TABLES_AS_THEY_ARE}${atDoubling(bulk.transactions, 32) ? `; ${ANALYZE_TABLES_OF_LARGE_WRITE}` : ""}`, fn);
}

// ── Writes that make many rows ──────────────────────────────────────────────
// A generic plan this pooled connection cached while a table was small (a trigger's lookup, the check of a foreign key, a deferred check at COMMIT)
// stays a read of the whole table however large the table grows: a transaction that made N notes read N × N rows at its COMMIT, and so did N
// one-note imports on one connection (issue #2001; versionCommitCost.integration.test.ts counts them). A large write plans each statement for the
// tables as they are now (plan_cache_mode = force_custom_plan). Not every write: on PGlite (the desktop and the browser) planning every statement
// of an ordinary save cost about 5 % of its time, so ordinary saves keep the cached plans. Three ways in, one setting:
//   * withBulkWrites(fn): every write transaction fn begins, and the one it runs in (the import route, a backup restore);
//   * planThisTransactionForTablesAsTheyAre(): the rest of the current transaction (a merge, spine/stampedImport.ts openMerge; a transaction that has
//     minted many versions, spine/noteVersions.ts recordVersion);
//   * migrate(): each migration's transaction (a data step may fill a table row by row).
// A plan made for the tables as they are still reads them as the statistics describe them: a table its statistics saw nearly empty can make the
// planner pick an index that reads every row (a note's read check on content_nodes_space_idx instead of the key). So a large write also brings the
// statistics of the tables a note write fills up to date, at a doubling (the 32nd, 64th, 128th … transaction of withBulkWrites; the 100th, 200th,
// 400th … version of one transaction, analyzeTablesOfLargeWrite): log₂ of the write's size times, each one a sample of at most 30,000 rows a table,
// as the merge does (spine/stampedMerge/dbRows.ts). ANALYZE in a transaction counts its own new rows, needs no more than the write's own role (a role
// that does not own a table gets a WARNING and the old statistics), and holds its lock (SHARE UPDATE EXCLUSIVE, which only another ANALYZE or VACUUM
// waits for) until the transaction ends. So it skips a table another transaction holds (SKIP_LOCKED): that one is analyzing it, the statistics are
// about to be new, and waiting would make a second large write wait for the first's COMMIT, or the merge's table-by-table ANALYZE and this list
// wait for each other (largeWrites.integration.test.ts).
const PLAN_FOR_TABLES_AS_THEY_ARE = "SET LOCAL plan_cache_mode = force_custom_plan";
const ANALYZE_TABLES_OF_LARGE_WRITE = "ANALYZE (SKIP_LOCKED) content_nodes, node_attributes, note_link_index, node_edges, domain_events, note_versions, note_version_positions, note_version_events, sync_stamps";
const bulkWrites = createContextSlot<{ transactions: number }>();

/** Bring the statistics of the tables a note write fills up to date, inside the current transaction (see above). */
export async function analyzeTablesOfLargeWrite(): Promise<void> {
  requireTransaction("analyzeTablesOfLargeWrite");
  await q(ANALYZE_TABLES_OF_LARGE_WRITE);
}

/** The rest of the current transaction, its COMMIT included, plans each statement for the tables as they are now (see above). */
export async function planThisTransactionForTablesAsTheyAre(): Promise<void> {
  requireTransaction("planThisTransactionForTablesAsTheyAre");
  await q(PLAN_FOR_TABLES_AS_THEY_ARE);
}

/** Every write transaction `fn` begins (in the BEGIN's own round trip: a simple query, two statements), and the one it runs in if any, plans each
 *  statement for the tables as they are now (see above). For a write that makes many rows over many transactions. Example:
 *  withBulkWrites(() => importFiles(files)). */
export function withBulkWrites<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(bulkWrites.run({ transactions: 0 }, async () => {
    if (txStorage.getStore()) await q(PLAN_FOR_TABLES_AS_THEY_ARE);
    return fn();
  }));
}

/** One read-only database snapshot for all q() calls in fn, including helpers.
 *  Example: withReadSnapshot(async () => { const scope = await readScope();
 *    return readProjection(scope); }). No query can see a later commit than the
 *  first query's snapshot. This does not refresh an actor already read by auth,
 *  or hold a snapshot across HTTP requests. Must start outside any transaction:
 *  joining a write transaction cannot provide this isolation/read-only contract.
 *  Errors discard the result; connection cleanup is identical to writes. */
export function withReadSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  if (txStorage.getStore()) throw new Error("read snapshot must start outside an existing transaction");
  return runTransaction("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", fn);
}

async function runTransaction<T>(begin: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // If transaction cleanup (COMMIT/ROLLBACK) doesn't complete, the connection may
  // still be mid-transaction. Returning it to the pool would let the NEXT
  // pool.query() that reuses it run inside this zombie tx — reads see uncommitted
  // data, writes land uncommitted-and-invisible-to-other-connections. Track that
  // and evict the poisoned client (release with an error) instead of reusing it.
  return withTxHookScope(async () => {
    let poisoned = false;
    try {
      await client.query(begin);
      const result = await txStorage.run(client, fn);
      const committed = await client.query("COMMIT");
      // PostgreSQL answers COMMIT with ROLLBACK if a swallowed SQL error left
      // the transaction aborted. That is not an accepted write or a success tick.
      if (committed.command === "ROLLBACK") throw new Error("transaction was aborted before commit");
      return result;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ROLLBACK failed — the connection's tx state is unknown; don't reuse it.
        poisoned = true;
      }
      throw translateUnitInConflict(e);
    } finally {
      eventLockedClients.delete(client);
      stampedClients.delete(client);
      client.release(poisoned ? new Error("tx cleanup failed; evicting connection") : undefined);
    }
  });
}

let savepointSequence = 0;

/** A recoverable unit of work: rollback its writes AND post-commit hooks before
 *  exposing a failure to a caller that may continue its surrounding transaction.
 *  Unlike withTransaction(), nesting creates a savepoint. Await nested units in
 *  sequence; concurrent savepoint branches on the same PG client are unsupported.
 *  Successful work remains subject to the surrounding transaction's commit. */
export async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const client = txStorage.getStore();
  if (!client) return withTransaction(fn);

  // Generated internally, never interpolated from a request or domain identifier.
  const name = `onden_unit_${++savepointSequence}`;
  return withTxHookScope(async () => {
    await client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
      } catch (cleanupError) {
        // Do not disguise a broken transaction as a recoverable domain rejection.
        throw new AggregateError([error, cleanupError], "savepoint rollback failed");
      }
      throw translateUnitInConflict(error);
    }
  });
}

/** True when the current async context is already inside a withTransaction.
 *  The spine (services/spine) reads this to decide whether to open a fresh
 *  transaction or reuse the one a parent already holds — so a cascade of
 *  mutate() calls commits as one unit instead of opening nested clients. */
export function inTransaction(): boolean {
  return txStorage.getStore() !== undefined;
}

/** Row helpers that write on behalf of a caller (a slug follow-up, a board's
 *  sections) have no authority or event of their own: the caller's mutate() or
 *  withEventTransaction() provides both. Calling one outside any transaction
 *  would commit the row alone, with no event and no lock, so it refuses.
 *  test/spineGate.test.ts lists the helpers that rely on this. */
export function requireTransaction(helper: string): void {
  if (!inTransaction()) {
    throw new Error(`${helper} writes inside its caller's transaction (mutate() or withEventTransaction()), and none is open`);
  }
}

// Fixed key for the session-level advisory lock that serialises migrate()
// across instances (arbitrary but stable). Two backends booting at once used to
// both see a migration unapplied, both run its SQL, then one INSERT into
// schema_migrations would lose the PK race and crash that instance on boot.
const MIGRATION_LOCK_KEY = 4_242_042_042;

/** Raised by migrate() when schema_migrations records versions this build has no
 *  file for: the database was migrated by a newer release (the image was rolled
 *  back without restoring the database). Running on would let old code write
 *  into a schema it does not understand, so boot stops instead. */
export class DatabaseNewerThanCodeError extends Error {
  constructor(readonly unknownVersions: string[]) {
    super(`database has ${unknownVersions.length} migration(s) this version does not know: ${unknownVersions.join(", ")}`);
    this.name = "DatabaseNewerThanCodeError";
  }
}

/** Applied versions with no migration file in this build, sorted. Only the
 *  "applied but unknown" direction counts: unapplied files are a normal upgrade. */
export function unknownMigrationVersions(applied: Iterable<string>, known: Iterable<string>): string[] {
  const knownSet = new Set(known);
  return [...applied].filter((v) => !knownSet.has(v)).sort();
}

/** `seedNativeActor` (default: the native bypass is enabled — tests, or dev
 *  with ALLOW_NATIVE_BYPASS=1) re-creates the System actor and its default-space
 *  seat on boot. Production never does: the bypass that signs in as System is
 *  off there, so the owner may remove it and it stays removed. */
export async function migrate({ seedNativeActor = nativeBypassEnabled() }: { seedNativeActor?: boolean } = {}) {
  // The advisory lock is session-level — it must be acquired AND released on the
  // SAME connection, so the whole migration run is pinned to one dedicated
  // client (also the one that runs the migrations, holding the lock throughout).
  const client = await pool.connect();
  try {
    // Serialise concurrent boots: the first instance holds the lock and
    // migrates; others block here, then find every migration already applied and
    // no-op. Blocks (not pg_try_advisory_lock) so a slower instance waits for the
    // migrator instead of booting against a half-migrated schema.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // A database without the production extensions (PGlite) gets the same SQL minus those
    // extensions, plus pg_trgm for the portable search engine.
    if (dbDriver === "pglite") {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm");
    }
    const migrations = await listMigrations();
    const appliedRows = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const unknown = unknownMigrationVersions(appliedRows.rows.map((r) => r.version), migrations.map((m) => m.version));
    if (unknown.length > 0) throw new DatabaseNewerThanCodeError(unknown);

    for (const { version, sql: fileSql } of migrations) {
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version],
      );
      if (rows.length > 0) continue;
      const sql = dbDriver === "pglite" ? portableMigrationSql(fileSql) : fileSql;
      // SQL + bookkeeping in ONE transaction: a crash partway through rolls the
      // schema change back TOGETHER with its (unwritten) record, so the next
      // boot re-runs the migration cleanly instead of inheriting a half-applied,
      // unrecorded schema. (All migrations are transaction-safe — none use
      // CONCURRENTLY or top-level BEGIN/COMMIT.)
      try {
        await client.query("BEGIN");
        // A backfill over a large table may outlast a request's timeout; LOCAL ends with this transaction.
        await client.query("SET LOCAL statement_timeout = 0");
        // A data step may fill a table row by row: each statement is planned for the tables as they are (see withBulkWrites).
        await client.query(PLAN_FOR_TABLES_AS_THEY_ARE);
        // A migration's data step runs on every node by itself: it mints no version (each node would mint a different `s:`), and the
        // commit check of migration 220 stands aside (docs/agents/migrations.md rule 8; history-replication proposal §4.4 point 11).
        await client.query("SELECT set_config('onden.no_versions', 'on', true)");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      log.info("migrate", `applied ${version}`);
    }

    if (dbDriver === "pglite") {
      // What pgroonga's index is on a server: lets portable search (services/search) skip a full scan for 3+ characters.
      await client.query("CREATE INDEX IF NOT EXISTS content_nodes_trgm_idx ON content_nodes USING gin (title gin_trgm_ops, markdown gin_trgm_ops)");
    }

    // A snapshot import that was cut off (the process died between pages) left a half-filled workspace and a 'joining' record:
    // discard it, then make the empty workspace again, so the database is the empty one a person can join from.
    // One transaction: a crash between the discard and the person's return must not lose the person (they go back, with their sign-in).
    await client.query("BEGIN");
    try {
      const person = await discardUnfinishedJoins(client);
      await ensureShellWorkspace(client, seedNativeActor);
      if (person) await restoreShellPerson(client, person);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
  } finally {
    // Release the lock (best-effort) and return the connection. A session-level
    // advisory lock would also auto-release when the connection closes, but
    // unlocking explicitly returns a clean connection to the pool.
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** What a query runner looks like to the two functions below: the migration's own client, or q() inside a transaction. */
type ShellClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** A workspace that was being filled from a snapshot and never finished (the process died, or the import was abandoned half way) is
 *  removed with its stamps and clock: the foreign keys take what it owns. Nothing to do before migration 204 is applied. */
export async function discardUnfinishedJoins(client: ShellClient, onlyWorkspaceId?: string): Promise<ShellPerson | null> {
  if (!(await client.query(`SELECT to_regclass('sync_join') AS t`)).rows[0]?.t) return null;
  let person: ShellPerson | null = null;
  for (const { workspace_id, shell_person } of (await client.query(
    `SELECT workspace_id::text, shell_person FROM sync_join WHERE state = 'joining' AND ($1::uuid IS NULL OR workspace_id = $1) FOR UPDATE`, [onlyWorkspaceId ?? null])).rows) {
    await client.query(`DELETE FROM workspaces WHERE id = $1`, [workspace_id]);
    await client.query(`DELETE FROM sync_stamps WHERE workspace_id = $1`, [workspace_id]);
    if ((await client.query(`SELECT to_regclass('sync_stamp_heads') AS t`)).rows[0]?.t) await client.query(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1`, [workspace_id]);
    await client.query(`DELETE FROM sync_clock WHERE workspace_id = $1`, [workspace_id]);
    await client.query(`DELETE FROM sync_join WHERE workspace_id = $1`, [workspace_id]);
    person = (shell_person as ShellPerson | null) ?? person;
  }
  return person;
}

/** The one person the empty database had when a join began (what stampedImport.ts beginJoin saves in sync_join.shell_person). */
export type ShellPerson = { id: string; name: string; external_id: string | null; write_mode: string; owner: boolean };

/** Put that person back into the shell with the same id, sign-in link and write mode, and the ownership when they had it: the person who
 *  tried to join and was refused is the same person afterwards (not a new row the next sign-in would make, with another id). */
export async function restoreShellPerson(client: ShellClient, person: ShellPerson): Promise<void> {
  const ws = (await client.query(`SELECT id::text FROM workspaces WHERE slug = 'default' LIMIT 1`)).rows[0] as { id: string } | undefined;
  if (!ws) throw new Error("the shell has no workspace to put the person back into");
  await client.query(
    `INSERT INTO actors (id, workspace_id, name, type, external_id, write_mode) VALUES ($1, $2, $3, 'human', $4, $5) ON CONFLICT (id) DO NOTHING`,
    [person.id, ws.id, person.name, person.external_id, person.write_mode]);
  if (person.owner) await client.query(`UPDATE workspaces SET owner_actor_id = $2 WHERE id = $1 AND owner_actor_id IS NULL`, [ws.id, person.id]);
}

/** The empty workspace a database starts with, made idempotently (nothing is made twice). Every boot runs it, and so does a
 *  cancelled snapshot import, so the person can sign in and try again without a restart. */
export async function ensureShellWorkspace(client: ShellClient, seedNativeActor: boolean): Promise<void> {
    // The shell is no one's write: it has no versions (an untouched shell holds no version and no blob, or a join is refused:
    // spine/snapshotTables.json rows_of_blobs). Its callers run it in their own transaction, which this setting ends with.
    await client.query("SELECT set_config('onden.no_versions', 'on', true)");
    // Ensure the single-tenant default workspace exists, every boot, idempotently.
    // A fresh deploy initdb-loads the schema-only snapshot (schema.sql), which marks
    // ALL migrations applied but carries no seed rows — so migration 001's workspace
    // seed never runs there and getWorkspaceId() would throw "default workspace was
    // not created". Reconciling it here (not just in 001, not just in the e2e seed)
    // is the real fix; it's a no-op on an already-seeded DB.
    await client.query(
      `INSERT INTO workspaces (name, slug) VALUES ('Onden MVP', 'default') ON CONFLICT (slug) DO NOTHING`,
    );
    // Same reasoning for the native System actor (external_id='system') — the
    // actor resolved for sessionless / native-origin requests. Migration 001
    // seeds it, but a schema.sql-loaded DB marks 001 applied without running its
    // data INSERT, so reconcile it here too (no-op once present). Only where
    // the native bypass can use it: in production nothing signs in as System,
    // so it is not re-created there and an owner's removal sticks.
    if (seedNativeActor) {
      await client.query(
        `INSERT INTO actors (workspace_id, name, type, external_id)
         SELECT id, 'System', 'agent', ${SYSTEM_EXTERNAL_ID_SQL} FROM workspaces WHERE slug = 'default'
         ON CONFLICT (workspace_id, external_id) DO NOTHING`,
      );
    }
    // This installation's node id (migration 190), made here, committed, so that the first writers never wait on
    // another transaction's uncommitted first insert of it. The write stamps make it themselves if a database
    // gets here another way (the same insert, so whoever is first wins).
    await client.query(`INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text) ON CONFLICT (singleton) DO NOTHING`);
    // And the default shared space (migration 093): a root note created
    // without a space lands there. It does not publish until the owner turns
    // that on (migration 186: the switch publishes every note in it).
    // Its id is derived from the workspace (migration 201), made here rather than by a SQL function so that a database whose
    // migrations stop before 201 (an older copy the browser app upgrades) still boots.
    const missing = await client.query(
      `SELECT w.id FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id AND s.is_default)`,
    );
    for (const { id } of missing.rows) {
      const derived = uuidV5(DERIVED_ID_NAMESPACE, derivedIdName.defaultSpace(id));
      await client.query(
        `INSERT INTO spaces (id, workspace_id, name, kind, is_default, capabilities)
         SELECT CASE WHEN EXISTS (SELECT 1 FROM spaces WHERE id = $2) THEN gen_random_uuid() ELSE $2::uuid END,
                $1, '共用', 'shared', true, '{"publish": false, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb
         ON CONFLICT DO NOTHING`,
        [id, derived],
      );
    }
    // The System actor (when there is one) edits it.
    if (seedNativeActor) {
      await client.query(
        `INSERT INTO space_members (space_id, actor_id, permission)
         SELECT s.id, a.id, 'edit' FROM spaces s JOIN actors a ON a.workspace_id = s.workspace_id AND a.external_id = ${SYSTEM_EXTERNAL_ID_SQL}
          WHERE s.is_default ON CONFLICT (space_id, actor_id) DO NOTHING`,
      );
    }
}

/** Run `fn` only while this process holds the named cross-instance lock (a Postgres session
 *  advisory lock: auto-released if the holder's connection dies). `{ held: false }` means another
 *  instance has it and `fn` did not run. A key is a fixed integer, or a name hashed by Postgres.
 *
 *    const r = await withLeaderLock({ key: 4_242_044_044 }, drainDueTasks);
 *
 *  The lock lives on its own connection so `fn`'s queries (pool.query) are not pinned to it.
 *  PGlite has one process and one connection: nothing can hold the lock elsewhere and a second
 *  connection to pin would deadlock the first, so `fn` simply runs. */
export async function withLeaderLock<T>(lock: { key: number } | { name: string }, fn: () => Promise<T>): Promise<{ held: true; value: T } | { held: false }> {
  if (dbDriver === "pglite") return { held: true, value: await fn() };
  const [expr, param] = "key" in lock ? ["$1", lock.key] : ["hashtext($1)", lock.name];
  const lockClient = await pool.connect();
  try {
    const got = await lockClient.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${expr}) AS locked`, [param]);
    if (!got.rows[0]?.locked) return { held: false };
    try {
      return { held: true, value: await fn() };
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(${expr})`, [param]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

/**
 * EXPERIMENTAL content-gated event pruning ("mode X"). DISABLED by default —
 * the scheduler only calls this when EVENT_PRUNE_EXPERIMENTAL=on. domain_events
 * is append-only (migrations 051 + 052); this is the ONLY sanctioned deletion path.
 *
 * Deletes only events that are ALL of:
 *   - target_type = 'node' — tag / canvas / workspace events are never pruned;
 *   - older than `graceDays` — never touch the live tail;
 *   - WITHOUT a body_hash (events->hash->blobs, step 4). A body-changing event
 *     carries body_hash pointing at retained content in the blob store, so it is
 *     immortal; only events whose content was never retained (pre-merge events,
 *     or pure metadata node events like NODE_PROMOTED) are ever prunable.
 *
 * The BEFORE DELETE trigger (domain_events_prevent_delete) independently enforces
 * that (1) any event carrying body_hash can never be deleted and (2)
 * myapp.allow_event_prune must be set — so even a buggy query here cannot violate
 * the append-only guarantee.
 */
export async function pruneEvents(opts: { graceDays?: number } = {}) {
  const graceDays = Math.max(0, opts.graceDays ?? 7);
  const client = await pool.connect();
  let poisoned = false;
  try {
    await client.query("BEGIN");
    // Transaction-local: authorises the sanctioned delete path for this tx only.
    await client.query("SELECT set_config('myapp.allow_event_prune', 'on', true)");
    const { rowCount } = await client.query(
      // Keep what a restore still needs: NODE_DELETED roots (undeleting a
      // subtree walks them) and events whose before/after value is a blob
      // reference (ink and large attribute undo). And the workspace's highest
      // event: MAX(id) is where every answer says it was read (services/sync/delta.ts workspaceHead,
      // frontend lib/answerPositions.ts); deleting it would put new answers below
      // what devices already know, and they would refuse them.
      `DELETE FROM domain_events e
        WHERE e.target_type = 'node'
          AND e.created_at < now() - ($1 || ' days')::interval
          AND NOT (e.payload ? 'body_hash')
          AND e.event_type <> 'NODE_DELETED'
          AND NOT (e.payload ? 'value_ref')
          AND (e.tx_meta->'prev_field_values'->>'value_ref') IS NULL
          AND e.id < (SELECT MAX(id) FROM domain_events m WHERE m.workspace_id = e.workspace_id)`,
      [graceDays],
    );
    await client.query("COMMIT");
    if (rowCount) log.info("prune", `removed ${rowCount} un-snapshotted node events (older than ${graceDays}d)`);
  } catch (err) {
    // Guard the ROLLBACK: if it throws, the connection's tx state is unknown —
    // evict it (release with an error) instead of returning a possibly-mid-tx
    // client to the pool, where its frozen snapshot would silently break reuses.
    try { await client.query("ROLLBACK"); } catch { poisoned = true; }
    throw err;
  } finally {
    client.release(poisoned ? new Error("tx cleanup failed; evicting connection") : undefined);
  }
}

// Single-tenant pin point — always returns the 'default' workspace.
// All workspace_id columns elsewhere look multi-tenant but currently aren't:
// Onden ships as a single-workspace system. Promoting this resolver to a
// per-session lookup is step 1 of any future multi-workspace work. The
// assumption is stated in the README ("Single-tenant" note) and guarded by
// src/test/workspaceBoundary.test.ts.
export async function getWorkspaceId() {
  const result = await q<{ id: string }>(
    "SELECT id FROM workspaces WHERE slug = 'default' LIMIT 1",
  );
  if (!result.rows[0]) {
    throw new Error("default workspace was not created");
  }
  return result.rows[0].id;
}

// Bump the workspace's membership epoch (the read-membership reconciliation
// keystone — docs/architecture/membership-and-permission-epoch.md). Call this IN
// THE SAME TRANSACTION as any state change that can alter readableNodeIdSet()
// (role / matter-scope / token-scope / tag policy / permission-tag apply-remove /
// reparent / restore of those). Declared by the mutation (mutate affectsMembership
// or an explicit call on the dispatcher/withTransaction tag paths) and executed
// once per such tx.
//
// MUST use q() (not pool.query): q() joins the caller's AsyncLocalStorage-bound
// transaction, so the bump commits/rolls back atomically WITH the state change +
// event. A pool.query() would commit independently and either leave a phantom
// epoch on a later rollback, or bump before the change is visible (a client
// reconciling in that window reads the OLD readable set and misses the change).
export async function bumpMembershipEpoch(workspaceId: string): Promise<void> {
  const r = await q<{ membership_epoch: string }>(
    `UPDATE workspaces SET membership_epoch = membership_epoch + 1 WHERE id = $1
     RETURNING membership_epoch`,
    [workspaceId],
  );
  // Fire the blind membership tick AFTER commit (afterCommit defers to the
  // enclosing tx) so clients raise their fail-closed gate + reconcile the instant
  // the permission change lands, not on the next poll. Rolls back with the tx.
  const epoch = Number(r.rows[0]?.membership_epoch ?? 0);
  afterCommit(() => notifyMembershipChanged(epoch));
}

/**
 * Optional restore + cascade context attached to a domain_event.
 *
 *   txMeta       — JSON blob written to domain_events.tx_meta. Conventional
 *                  keys (see migration 031 column comment):
 *                    inverse_patch (string)     — diff-match-patch inverse
 *                                                  for body markdown.
 *                    prev_field_values (object) — small-field prev values
 *                                                  (title, status, ...).
 *                    inverse_op (string)        — semantic inverse marker
 *                                                  for events whose revert
 *                                                  doesn't fit a patch
 *                                                  (`tag.removed`,
 *                                                   `node.created`, ...).
 *                    ui_context (string)        — which UI surface
 *                                                  initiated the event.
 *
 *   external     — Marks an event whose side effect is outside PG and
 *                  cannot be replayed (writeAndCommit, pushNoteToBackup,
 *                  GitHub Pages push, future MCP agent tool calls). The
 *                  restore endpoint MUST NOT attempt to revert these.
 *
 *   triggeredBy  — Cause event id when this emission is part of a
 *                  dispatcher cascade. See ER5 for the cascade walker.
 *
 * IMPORTING THIS OUTSIDE src/spine IS GATED: actor-attributed state mutations
 * go through spine mutate(); direct emission is reserved for the documented
 * bypass categories (cascade/system/external/audit/restore) enforced by
 * test/spineEventGate.test.ts — new importers fail that test until justified.
 */
export interface EventOptions {
  txMeta?: Record<string, unknown>;
  external?: boolean;
  triggeredBy?: string;
  /** sha256 hex of the body this write was made from (an editor's merge base).
   *  Only meaningful on an event carrying payload.body_hash; without it the base
   *  is the body the note's previous body event left (see insertEvent). `null`:
   *  the base is NOT KNOWN here (a write another node made, taken by bundle:
   *  spine/receivedEvents.ts): none is recorded, never this node's previous body. */
  baseHash?: string | null;
  /** The device the write was made on, when it is not this request's: a write another node made names the device its stamp names. */
  deviceId?: string | null;
}

/** Append one domain event. Ordering is guaranteed for every caller: outside a
 *  transaction the insert gets its own locked transaction; inside one the lock
 *  is re-acquired (a no-op when the writer already holds it). A transaction that
 *  changed state rows before its first event takes the lock late, which can
 *  deadlock against a writer that locked first — PostgreSQL aborts one of them
 *  instead of silently reordering ids. New writers should still lock first. */
export async function event(
  workspaceId: string,
  eventType: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
  // No defaults: attribution must be explicit at every call site. Omitting
  // actorType/actorId used to silently stamp 'user'/'demo-user' — the exact
  // hardcode the spine exists to kill. Required params surface any omission at
  // compile time.
  actorType: "user" | "ai_agent" | "system",
  actorId: string,
  options: EventOptions = {},
): Promise<string> {
  const append = async () => {
    await acquireEventAppendLock(q, workspaceId);
    return insertEvent(workspaceId, eventType, targetType, targetId, payload, actorType, actorId, options);
  };
  return inTransaction() ? append() : withTransaction(append);
}

async function insertEvent(
  workspaceId: string,
  eventType: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
  actorType: "user" | "ai_agent" | "system",
  actorId: string,
  options: EventOptions,
): Promise<string> {
  // Routes through q() so events emitted inside withTransaction roll back
  // together with the state changes that produced them.
  //
  // Returns the inserted event id (PG bigserial as string). Version history is
  // now DERIVED from events carrying payload.body_hash (events->hash->blobs);
  // the old content_node_versions CoW table + capture_node_version trigger were
  // retired in migration 053.
  // Version lineage (migration 162): every event that changes a note body records
  // the hash after (body_hash, copied from payload.body_hash) and the hash it was
  // made from (base_hash). Done here, the funnel all writes pass, so no writer
  // computes either. A caller that knows a better base (the editor's merge base)
  // passes options.baseHash; otherwise the base is the previous body event of the
  // node (events before 162 only carry the hash in their payload).
  const bodyHash = typeof payload.body_hash === "string" ? payload.body_hash : null;
  const replayedOp = replayedOpId();
  const result = await q<{ id: string }>(
    `INSERT INTO domain_events
      (workspace_id, actor_type, actor_id, event_type, target_type, target_id,
       payload, tx_meta, external, triggered_by_event_id, body_hash, base_hash, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       CASE WHEN $11::text IS NULL OR $14::boolean THEN NULL ELSE COALESCE($12::text,
         (SELECT COALESCE(p.body_hash, p.payload->>'body_hash') FROM domain_events p
           WHERE p.target_type = $5 AND p.target_id = $6 AND p.payload ? 'body_hash'
           ORDER BY p.created_at DESC, p.id DESC LIMIT 1)) END,
       $13::uuid)
     RETURNING id`,
    [
      workspaceId, actorType, actorId, eventType, targetType, targetId,
      payload,
      // An event written while replaying a replicated op says so, so distributed sync never sends it back (spine/replicatedOp.ts).
      replayedOp ? { ...options.txMeta, ds_op_id: replayedOp } : options.txMeta ?? {},
      options.external ?? false,
      options.triggeredBy ?? null,
      bodyHash,
      options.baseHash ?? null,
      // A system event (background work) has no device even when a request started the job.
      options.deviceId !== undefined ? options.deviceId : actorType === "system" ? null : currentDeviceId() ?? null,
      options.baseHash === null,
    ],
  );
  const id = result.rows[0]?.id ?? "";
  // Realtime: every committed domain event raises a blind "changed" tick on
  // the SSE hub — POST-COMMIT only (afterCommit defers to the enclosing
  // withTransaction's flush, including the one event() opens for a standalone
  // append). event() is the single funnel all
  // mutations flow through (spine mutate(), cascades, system events), which
  // makes this the one seam that can't be forgotten by a new route.
  if (id) afterCommit(() => notifyChanged(id));
  // The write's position for its response (spine/eventPosition.ts), noted after commit like the tick above.
  const noted = id ? await noteInsertedEvent(id) : null;
  if (noted) afterCommit(noted);
  return id;
}

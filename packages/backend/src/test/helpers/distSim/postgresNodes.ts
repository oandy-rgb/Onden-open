// A "node" of a single-process distributed-sync test on a REAL Postgres: a database of its own on the server of DATABASE_URL.
//
// The backend reaches its database through one process-wide handle (db.ts `pool`). On PGlite a node is a PGlite and the handle is pointed
// at it (realNode.ts). On a real server the same handle is one pg.Pool, whose new connections go to `pool.options.connectionString`:
// pointing it at another database of the server is setting that one string and letting go of the connections it holds for the old one.
// Nothing in product code changes: the seam is the public `options` of the pool the product already makes, used only by tests.
//
// What a node is, and what follows the switch (the audit is in the PR that added this file):
//   - everything the backend keeps in the database (the node id, the stamp clock, advisory locks, the event lock, workspace rows, epochs)
//     lives in the node's own database, so it follows by construction;
//   - what the backend keeps in memory is either keyed by a connection/transaction (WeakSets in db.ts) or a flag that can only go from false
//     to true for what every node has (spine/stamps.ts `joinTableKnown`), or registered code (module registries): none of it names a node.
//
// Names: `onden_node_<run>_<n>_test` (a node), and `onden_node_<run>_tpl_test` (the template every node is cloned from). `<run>` is the
// millisecond the run began plus a random tail. The suite's global setup drops everything of its own run when the run is over, and
// everything of an older run that no session is connected to any more (a crashed run) when the next one starts.
import pg from "pg";
import { migrate, pool } from "../../../db.js";
import { describeOutstanding } from "./connectionLedger.js";
import { isTestDatabase } from "../testDatabase.js";
import { buildDatabase } from "../databaseBuild.js";
import { NODE_DATABASE_PREFIX, NODE_DATABASE_SUFFIX, baseUrl, quotedIdentifier, runId, urlOfDatabase, withServer } from "./nodeDatabaseNames.js";

// ── the handle ──────────────────────────────────────────────────────────────────────────────────────────────────────

let pointedAt = baseUrl;

/** Make the process's pool talk to the database at `url` from now on. The caller (onNode) holds the process's one-node-at-a-time lock and has
 *  waited for the previous node's own work, so every connection is back; one that is not is a bug of the caller (a transaction left open on
 *  the old database must not be moved to the new one), and the error says whose. */
export async function pointPoolAt(url: string): Promise<void> {
  if (url === pointedAt) return;
  if (pool.totalCount !== pool.idleCount) throw new Error(`cannot switch databases: ${pool.totalCount - pool.idleCount} connection(s) of the previous node are still in use:\n${describeOutstanding()}`);
  // release(true) closes the connection instead of returning it to the pool, but returns before it is closed: pg sends Terminate and the
  // client's 'end' comes when the server has closed its side, after its session has left pg_stat_activity. Not waiting for it left the old
  // node's last connection listed for a moment (nodeDatabaseSwitch.integration.test.ts on public CI, 2026-11-22: "a connection to switch-a
  // is left", an idle client backend whose last SQL was the round before's), and a DROP or a TEMPLATE copy of that database could meet it too.
  const closed: Promise<void>[] = [];
  while (pool.idleCount > 0) {
    const client = await pool.connect();
    closed.push(new Promise((resolve) => client.once("end", () => resolve())));
    client.release(true);
  }
  await Promise.all(closed);
  pool.options.connectionString = url;
  pointedAt = url;
}
/** Let go of every connection to `database` (so it can be cloned or dropped), leaving the pool pointed where it was unless it was there. */
export async function leaveDatabase(database: string): Promise<void> {
  if (pointedAt === urlOfDatabase(database)) await pointPoolAt(baseUrl);
}

// ── the databases ───────────────────────────────────────────────────────────────────────────────────────────────────

let counter = 0;

/** One template per run: the schema and what migrate() makes of an empty database (the default workspace, the shell, the node id), with the
 *  AI module agreed to the way globalSetup does it for the shared database. Built the first time a node is wanted, by the process that
 *  wants it; a Postgres advisory lock keeps two processes from building it at once. */
async function ensureTemplate(): Promise<string> {
  const name = `${NODE_DATABASE_PREFIX}${runId()}_tpl${NODE_DATABASE_SUFFIX}`;
  await withServer(async (admin) => {
    await admin.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
    try {
      if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount) return;
      const staging = `${name.slice(0, -NODE_DATABASE_SUFFIX.length)}_building${NODE_DATABASE_SUFFIX}`;
      await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(staging)} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${quotedIdentifier(staging)}`);
      const c = new pg.Client({ connectionString: urlOfDatabase(staging) });
      await c.connect();
      // Every migration from nothing, not schema.sql: the PGlite template is made that way, and the rows the migrations seed (the built-in tags, ...)
      // are what a database that was migrated step by step holds; a database loaded from the schema-only dump (the shared test database) lacks them.
      try {
        await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
        await buildDatabase(c, false);
      } finally { await c.end(); }
      // migrate() is the app's own boot, so it makes the same shell a first start makes
      await pointPoolAt(urlOfDatabase(staging));
      try {
        await migrate();
        await pool.query(`UPDATE workspaces SET modules_confirmed = COALESCE(modules_confirmed, '[]'::jsonb) || '["ai"]'::jsonb
                          WHERE slug = 'default' AND NOT COALESCE(modules_confirmed, '[]'::jsonb) ? 'ai'`);
      } finally { await pointPoolAt(baseUrl); }
      await admin.query(`ALTER DATABASE ${quotedIdentifier(staging)} RENAME TO ${quotedIdentifier(name)}`); // a template appears whole or not at all
    } finally { await admin.query("SELECT pg_advisory_unlock(hashtext($1))", [name]); }
  });
  return name;
}

/** A new database on the server: a copy of the run's template, or of `copyOf` as it is now. */
export async function createNodeDatabase(copyOf?: string): Promise<string> {
  if (!isTestDatabase()) throw new Error("node databases are made only on a local server whose DATABASE_URL names a *_test database");
  const template = copyOf ?? (await ensureTemplate());
  if (copyOf) await leaveDatabase(copyOf); // CREATE DATABASE … TEMPLATE refuses a template somebody is connected to
  const name = `${NODE_DATABASE_PREFIX}${runId()}_${++counter}${NODE_DATABASE_SUFFIX}`;
  // STRATEGY = FILE_COPY, not the default WAL_LOG (Postgres 15+): WAL_LOG copies the relations the catalogue knows, block by block, and
  // leaves behind every file in the database's directory that is not one. PGroonga keeps its indexes in such files (its own Groonga
  // database beside the relations), so a WAL_LOG copy has pgroonga indexes that point at nothing and the first INSERT into content_nodes
  // fails with "pgroonga: PGrnLookupWithSize: object isn't found" (public CI, 2026-11-17: Postgres 18 + PGroonga 4.0.6). FILE_COPY copies
  // the directory whole. It is the one place a node database is made, for a new node and for a copy of a node alike.
  await withServer((admin) => admin.query(`CREATE DATABASE ${quotedIdentifier(name)} TEMPLATE ${quotedIdentifier(template)} STRATEGY = FILE_COPY`));
  return name;
}

/** Drop a node's database, also when the test failed (the caller is an afterAll). */
export async function dropNodeDatabase(database: string): Promise<void> {
  await leaveDatabase(database);
  await withServer((admin) => admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(database)} WITH (FORCE)`));
}


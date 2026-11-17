// Vitest globalSetup: prints the shuffle seed and prepares the ONE shared test
// database every integration file runs against.
//
// The integration files share a single database on purpose (closer to prod,
// where other people's data always exists): each test makes its own actors,
// notes and ids and scopes its queries and assertions to them, so it passes
// whatever else is in the database and in whatever order the files and tests
// run (docs: packages/backend/README.md, "Tests").
//
// DATABASE_URL must name a `…_test` database (helpers/testDatabase.ts). At
// suite start that database is rebuilt from db/schema.sql (plus any migration
// newer than the snapshot); ONDEN_TEST_DB_KEEP=1 keeps it and its leftovers
// instead, which is how a second run proves the tests do not need a clean
// database. Without a test DATABASE_URL nothing is touched and the
// integration files skip.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { databaseName, isTestDatabase } from "./helpers/testDatabase.js";
import { buildDatabase } from "./helpers/databaseBuild.js";
import { dropNodeDatabases, runId } from "./helpers/distSim/nodeDatabaseNames.js";


// Snapshot databases other work relies on: never drop or rebuild them.
const NEVER_REBUILD = /^onden_mperf_/;

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** PGlite runs: there is no server to rebuild. Migrate one in-memory database once and save it as a
 *  tar; every test file's own PGlite starts from that (db.ts ONDEN_PGLITE_SNAPSHOT), so files are
 *  isolated from each other, which the shared Postgres database cannot give them. */
async function buildPgliteTemplate(): Promise<void> {
  const started = Date.now();
  delete process.env.ONDEN_PGLITE_SNAPSHOT;
  delete process.env.ONDEN_PGLITE_DIR;
  const { migrate, pool, pglite } = await import("../db.js");
  await migrate();
  // The same agreement the shared Postgres database below gets: the default workspace has the ai module on, like a
  // workspace that used AI before it became a module (migration 159); agent and MCP tests run there.
  await pool.query(`UPDATE workspaces SET modules_confirmed = COALESCE(modules_confirmed, '[]'::jsonb) || '["ai"]'::jsonb
                    WHERE slug = 'default' AND NOT COALESCE(modules_confirmed, '[]'::jsonb) ? 'ai'`);
  const db = await pglite!.database();
  const tar = Buffer.from(await (await db.dumpDataDir("none")).arrayBuffer());
  await pool.end();
  const file = resolve(templateDir(), "template.tar");
  writeFileSync(file, tar);
  process.env.ONDEN_PGLITE_SNAPSHOT = file;
  console.log(`[db] PGlite test template built in ${Date.now() - started} ms (${(tar.length / 1048576).toFixed(1)} MiB)`);
}

/** One temp directory per run, and every worker's `os.tmpdir()` points into it (env is inherited by the workers started
 *  after this), so what a test leaves behind is exactly what is in it when the run ends. */
let runTmp = "";
const templateDir = (): string => resolve(runTmp, "pglite-template");

/** Runs when the whole run is over: removes the PGlite template, then fails the run (exit code 1) when anything else is left in the
 *  run's temp directory (a test that made a directory and did not remove it). */
function checkTempLeftovers(): void {
  rmSync(templateDir(), { recursive: true, force: true });
  // tsx (the db-types guard runs scripts through it) keeps its own cache in `tsx-<uid>` under the temp directory.
  const left = readdirSync(runTmp).filter((name) => !/^tsx-\d+$/.test(name));
  rmSync(runTmp, { recursive: true, force: true });
  if (left.length > 0) {
    // Not a throw: vitest only logs an error from a teardown and still exits 0.
    console.error(`\n[tmp] FAILED: tests left ${left.length} file(s) or folder(s) in the temp directory (remove them in afterAll): ${left.join(", ")}`);
    process.exitCode = 1;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  runTmp = mkdtempSync(resolve(tmpdir(), "onden-test-run-"));
  mkdirSync(templateDir());
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = runTmp;
  await prepare(project);
  return async () => {
    await dropNodeDatabasesOfThisRun();
    checkTempLeftovers();
  };
}

/** Real Postgres: the databases single-process multi-node tests made on the server (helpers/distSim/postgresNodes.ts) are dropped by the
 *  tests that made them; whatever a failed or killed worker left, and the run's template, go here. */
async function dropNodeDatabasesOfThisRun(): Promise<void> {
  if (process.env.ONDEN_DB_DRIVER === "pglite" || !isTestDatabase()) return;
  try { await dropNodeDatabases({ run: runId() }); } catch (e) { console.error(`[db] could not drop this run's node databases: ${(e as Error).message}`); }
}

async function prepare(project: TestProject): Promise<void> {
  const { sequence } = project.config;
  if (sequence.shuffle) {
    // Printed on every run so a failing order can be replayed exactly.
    console.log(`\n[order] shuffled with seed ${sequence.seed} — rerun this order with --sequence.seed=${sequence.seed}\n`);
  }

  if (process.env.ONDEN_DB_DRIVER === "pglite") return buildPgliteTemplate();

  const url = process.env.DATABASE_URL;
  if (!isTestDatabase(url)) return;
  // The run's name for the node databases, known to every worker started after this; and what crashed runs left on the server goes now.
  runId();
  const swept = await dropNodeDatabases({ staleRuns: true, keep: runId() }).catch(() => []);
  if (swept.length > 0) console.log(`[db] dropped ${swept.length} node database(s) a crashed run left behind`);
  const name = databaseName(url);
  const keep = process.env.ONDEN_TEST_DB_KEEP === "1" || NEVER_REBUILD.test(name);
  const ident = `"${name.replace(/"/g, '""')}"`;

  const exists = await withClient(withDatabase(url!, "postgres"), async (admin) => {
    const found = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount! > 0;
    if (found && keep) return true;
    if (found) await admin.query(`DROP DATABASE ${ident} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ident}`);
    return false;
  });

  await withClient(url!, async (c) => {
    const hasSchema = exists
      && (await c.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t !== null;
    await buildDatabase(c, !hasSchema);
    // The shared default workspace (the one getWorkspaceId() answers) has the ai module agreed to, like a
    // workspace that used AI before it became a module (migration 159): many files run agent tools and
    // MCP routes there at the same time, and none of them may depend on another having turned it on.
    await c.query(`INSERT INTO workspaces (name, slug, modules_confirmed) VALUES ('Test', 'default', '["ai"]'::jsonb)
                   ON CONFLICT (slug) DO UPDATE SET modules_confirmed = COALESCE(workspaces.modules_confirmed, '[]'::jsonb) || '["ai"]'::jsonb
                   WHERE NOT COALESCE(workspaces.modules_confirmed, '[]'::jsonb) ? 'ai'`);
  });
  console.log(`[db] ${keep && exists ? "kept" : "rebuilt"} shared test database ${name}`);
}

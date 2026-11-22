// scripts/restore.sh itself, run for real against the test's Postgres server (CI: PG 18 with pgroonga, the image compose uses; review of
// PR #1937, point 4). The script is a shell around psql, so this needs psql and gunzip on the host and a role that can create databases;
// on PGlite there is no server to run it against, and only the first test runs. What is proved here, on a database with data:
//   - a restore swaps the backup in and the restored database is a new node, the old id a former one; the replaced database is kept;
//   - pgroonga works on the restored database (search finds a note; a write goes through);
//   - a backup whose last statement fails, and a cut backup, change nothing: the live database, its pgroonga search and its writes are as
//     they were, and no <name>_restoring is left.
// The full set of cases (every era of backup, --keep-node-id, -Fc, killed runs) is the PR's real-Postgres run; this file keeps the part that
// depends on the server's version and extensions in CI.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbDriver } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const RESTORE = join(REPO, "scripts", "restore.sh");

it("restore.sh --help names the three kinds of backup it takes", () => {
  const run = spawnSync("bash", [RESTORE, "--help"], { encoding: "utf8" });
  expect(run.status).toBe(0);
  for (const kind of ["onden-<ts>.sql.gz", "database.dump", "manual-<ts>/", "--keep-node-id"]) expect(run.stdout).toContain(kind);
});

// it makes and drops databases on the server DATABASE_URL names: only on a test database
if (dbDriver === "postgres" && isTestDatabase()) describe("scripts/restore.sh on the real Postgres server", () => {
  const url = new URL(process.env.DATABASE_URL!);
  const urlFor = (db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
  const suffix = Math.random().toString(36).slice(2, 8);
  // every database this file makes, and the only ones it drops: this prefix plus restore.sh's _restoring / _before_restore_<stamp>
  const TARGET = `onden_restore_test_${suffix}`;
  const work = mkdtempSync(join(tmpdir(), "restore-script-"));
  const admin = () => new pg.Client({ connectionString: urlFor("postgres") });
  async function sql<T extends pg.QueryResultRow = Record<string, unknown>>(db: string, text: string): Promise<T[]> {
    const c = new pg.Client({ connectionString: urlFor(db) });
    await c.connect();
    try { return (await c.query<T>(text)).rows; } finally { await c.end(); }
  }
  async function databases(): Promise<string[]> {
    const c = admin(); await c.connect();
    try { return (await c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1`, [TARGET])).rows.map((r) => r.datname); } finally { await c.end(); }
  }
  afterAll(async () => {
    const c = admin(); await c.connect();
    try { for (const db of await databases()) await c.query(`DROP DATABASE "${db}" WITH (FORCE)`); } finally { await c.end(); }
    rmSync(work, { recursive: true, force: true });
  });

  /** The repo's schema snapshot and the drill's seed, as a backup.sh dump would carry them (pg_dump's last line included). psql's \restrict
   *  lines are left out: the host's psql can be older than the server's pg_dump. Without pgroonga on the server (a local run) its lines go too. */
  async function backupText(withPgroonga: boolean): Promise<string> {
    const schema = readFileSync(join(REPO, "packages/backend/db/schema.sql"), "utf8").split("\n")
      .filter((l) => !/^\\(un)?restrict /.test(l) && !/^SET transaction_timeout/.test(l)) // and a setting PG 16 does not know
      .filter((l) => withPgroonga || !/^CREATE EXTENSION IF NOT EXISTS pgroonga|^COMMENT ON EXTENSION pgroonga|pgroonga \(/.test(l)).join("\n");
    return `${schema}\n${readFileSync(join(REPO, "packages/backend/scripts/drillSyntheticSeed.sql"), "utf8")}\n--\n-- PostgreSQL database dump complete\n--\n`;
  }
  const psqlLoad = (db: string, file: string) => spawnSync("psql", [urlFor(db), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
  const restore = (file: string, db = target) => spawnSync("bash", [RESTORE, file, "--yes"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(db) } });
  const nodeId = async (db: string) => (await sql<{ node_id: string }>(db, `SELECT node_id FROM sync_node`))[0]?.node_id;
  /** pgroonga's search and a write, on `db`; null when the server has no pgroonga. */
  async function searchAndWrite(db: string): Promise<{ found: number; wrote: number } | null> {
    if ((await sql(db, `SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`)).length === 0) return null;
    const word = (await sql<{ w: string }>(db, `SELECT split_part(title, ' ', 1) AS w FROM content_nodes WHERE deleted_at IS NULL AND title <> '' ORDER BY id LIMIT 1`))[0]!.w;
    const found = Number((await sql<{ n: string }>(db, `SELECT count(*)::text AS n FROM content_nodes WHERE title &@~ '${word.replaceAll("'", "''")}'`))[0]!.n);
    const wrote = Number((await sql<{ n: string }>(db, `WITH u AS (UPDATE content_nodes SET title = title || ' x' WHERE id = (SELECT id FROM content_nodes WHERE deleted_at IS NULL ORDER BY id LIMIT 1) RETURNING 1) SELECT count(*)::text AS n FROM u`))[0]!.n);
    return { found, wrote };
  }

  let withPgroonga = false;
  beforeAll(async () => {
    expect(spawnSync("psql", ["--version"]).status, "psql must be installed on the host for this test (postgresql-client)").toBe(0);
    withPgroonga = (await sql(url.pathname.slice(1), `SELECT 1 FROM pg_available_extensions WHERE name = 'pgroonga'`)).length > 0;
    if (process.env.CI) expect(withPgroonga, "CI runs this on the pgroonga image").toBe(true);
    const text = await backupText(withPgroonga);
    writeFileSync(join(work, "backup.sql"), text);
    writeFileSync(join(work, "onden-backup.sql.gz"), gzipSync(text));
  }, 300_000);

  // Each test restores over a live database of its own (tests run in a random order, and CI runs this file on a server other files use):
  // <TARGET>_<n>z, the same data, then it went on writing. Everything a test made (its target, the copies and _restoring restore.sh adds
  // after that name) is dropped after it, so no test counts or trips over another's.
  let target = "";
  let made = 0;
  const ownedBy = (db: string, name: string) => name === db || name.startsWith(`${db}_`);
  beforeEach(async () => {
    target = `${TARGET}_${++made}z`;
    const c = admin(); await c.connect(); await c.query(`CREATE DATABASE "${target}"`); await c.end();
    const load = psqlLoad(target, join(work, "backup.sql"));
    expect(load.status, load.stderr).toBe(0);
    await sql(target, `UPDATE content_nodes SET title = title || ' live' WHERE id = (SELECT id FROM content_nodes ORDER BY id LIMIT 1)`);
  }, 300_000);
  afterEach(async () => {
    const c = admin(); await c.connect();
    try { for (const db of (await databases()).filter((d) => ownedBy(target, d))) await c.query(`DROP DATABASE "${db}" WITH (FORCE)`); } finally { await c.end(); }
  }, 300_000);

  it("restores over a database with data, renews the node id there, and keeps the replaced one; pgroonga works on the restored database", async () => {
    const liveId = await nodeId(target);
    const run = restore(join(work, "onden-backup.sql.gz"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    // this backup is SQL that numbers its own writes when it is loaded, so it carries an id of its own, not the live database's
    const [, backupId, newId] = /is a new node: id (\S+) -> (\S+)/.exec(run.stdout) ?? [];
    expect(await nodeId(target)).toBe(newId);
    expect(new Set([backupId, liveId]).size).toBe(2);
    expect(newId).not.toBe(liveId);
    // both former ids are held: the backup's (its own writes) and the replaced database's (none of its writes are in the backup)
    expect((await sql<{ origin: string }>(target, `SELECT DISTINCT origin FROM sync_origins WHERE vouched_by = 'self-restore' ORDER BY origin`)).map((r) => r.origin)).toEqual([backupId, liveId].sort());
    expect((await databases()).filter((d) => d.startsWith(`${target}_before_restore_`))).toHaveLength(1);
    expect(await databases()).not.toContain(`${target}_restoring`);
    const works = await searchAndWrite(target);
    if (withPgroonga) { expect(works!.found).toBeGreaterThan(0); expect(works!.wrote).toBe(1); }
  }, 300_000);

  it("a backup whose last statement fails, and a cut one, change nothing: the live database, its pgroonga search and its writes are as they were", async () => {
    const text = readFileSync(join(work, "backup.sql"), "utf8");
    const before = { id: await nodeId(target), notes: (await sql(target, `SELECT id, title FROM content_nodes ORDER BY id`)).length };
    const failing = text.replace("--\n-- PostgreSQL database dump complete\n--\n", "SELECT no_such_function();\n--\n-- PostgreSQL database dump complete\n--\n");
    writeFileSync(join(work, "failing.sql.gz"), gzipSync(failing));
    const gz = gzipSync(text);
    writeFileSync(join(work, "cut.sql.gz"), gz.subarray(0, Math.floor(gz.length * 0.6)));
    for (const name of ["failing.sql.gz", "cut.sql.gz"]) {
      const run = restore(join(work, name));
      expect(run.status, name).toBe(1);
      expect(run.stderr, name).toMatch(/nothing was changed|the database is as it was/i);
      expect(await nodeId(target), name).toBe(before.id);
      expect((await sql(target, `SELECT id FROM content_nodes ORDER BY id`)).length, name).toBe(before.notes);
      expect(await databases(), name).not.toContain(`${target}_restoring`);
      const works = await searchAndWrite(target);
      if (works) { expect(works.found, name).toBeGreaterThan(0); expect(works.wrote, name).toBe(1); }
    }
  }, 300_000);

  // the laptop drill of 2026-11-22: a 2026-10-31 backup carried Apache AGE's data (ag_catalog's config tables as COPY blocks), which the
  // schema/extension lines of scripts/lib/strip-age.sed did not cover; the -Fc form of the same is in scripts/restore-ci-selftest.sh
  it("a backup with Apache AGE (schema, extension, its config tables' data): AGE is left out, the rest is restored and renewed", async () => {
    const text = readFileSync(join(work, "backup.sql"), "utf8");
    const age = text
      .replace(/\n(CREATE SCHEMA|CREATE EXTENSION)/, "\nCREATE SCHEMA ag_catalog;\nCREATE EXTENSION IF NOT EXISTS age WITH SCHEMA ag_catalog;\nCOMMENT ON EXTENSION age IS 'AGE database extension';\n$1")
      .replace("--\n-- PostgreSQL database dump complete\n--\n",
        "COPY ag_catalog.ag_graph (graphid, name, namespace) FROM stdin;\n16385\tonden\tonden\n\\.\n\nCOPY ag_catalog.ag_label (name, graph, id, kind, relation, seq_name) FROM stdin;\n_ag_label_vertex\t16385\t1\tv\tonden._ag_label_vertex\t_ag_label_vertex_id_seq\n\\.\n\n" +
        "SELECT pg_catalog.setval('ag_catalog._label_id_seq', 3, true);\n\n--\n-- PostgreSQL database dump complete\n--\n");
    expect(age).toContain("COPY ag_catalog.ag_graph");
    writeFileSync(join(work, "age.sql.gz"), gzipSync(age));
    const before = await nodeId(target);
    const run = restore(join(work, "age.sql.gz"));
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/is a new node/);
    expect(await nodeId(target)).not.toBe(before);
    expect(await sql(target, `SELECT 1 FROM pg_namespace WHERE nspname = 'ag_catalog'`)).toHaveLength(0);
  }, 300_000);

  // the laptop drill of 2026-11-22: interrupted after the load and before the swap was sent, the script ended under set -e without a word,
  // leaving the copy. Here the script holds at that point (ONDEN_RESTORE_TEST_HOLD_BEFORE_SWAP) and is sent TERM there.
  it("interrupted after the load, before the swap: says the live database is as it was (it is), drops the copy, exits 130", async () => {
    const before = await nodeId(target);
    const hold = join(work, "hold");
    const child = spawn("bash", [RESTORE, join(work, "onden-backup.sql.gz"), "--yes"], {
      env: { ...process.env, DATABASE_URL: urlFor(target), ONDEN_RESTORE_TEST_HOLD_BEFORE_SWAP: hold }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 1200 && !existsSync(hold); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(hold), "the script reached the point before the swap").toBe(true);
    expect(await databases()).toContain(`${target}_restoring`);
    child.kill("SIGTERM");
    expect(await exited).toBe(130);
    rmSync(hold, { force: true });
    expect(stderr).toContain("the live database is as it was");
    expect(await nodeId(target)).toBe(before);
    expect(await databases()).not.toContain(`${target}_restoring`);
  }, 300_000);

  it("a target that holds no workspace (an empty schema) is not kept as a copy", async () => {
    const empty = `${target}_e`; // with restore.sh's _before_restore_<stamp> it stays within the 63 bytes of a Postgres name
    const c = admin(); await c.connect(); await c.query(`CREATE DATABASE "${empty}"`); await c.end();
    const run = restore(join(work, "onden-backup.sql.gz"), empty);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("held no workspace");
    expect((await databases()).filter((d) => d.startsWith(`${empty}_before_restore_`))).toHaveLength(0);
    expect(run.stdout + run.stderr).not.toMatch(/NOTICE/);
  }, 300_000);
});

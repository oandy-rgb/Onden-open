// Upgrade-path verification (升級遷移) against a real Postgres. The promise: a
// deploy that boots onto an existing DB converges — migrate() applies only the
// NEWER migrations incrementally and is a safe no-op when nothing is new. This
// is the production upgrade story (schema.sql is for fresh installs; existing
// DBs ride migrate()).
//
// SAFETY: only runs against a *_test database; skips otherwise.
//   DATABASE_URL=postgres://.../onden_test npx vitest run src/test/migration.integration.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, q, pool } from "../db.js";
import { needsPostgresServer } from "./helpers/pgliteSkips.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const fileVersions = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));

const seededCount = async () => {
  const r = await q<{ n: string }>(`SELECT count(*)::text AS n FROM schema_migrations`);
  return Number(r.rows[0]!.n);
};
const isSeeded = async (v: string) => {
  const r = await q(`SELECT 1 FROM schema_migrations WHERE version = $1`, [v]);
  return r.rows.length > 0;
};
const tableExists = async (t: string) => {
  const r = await q<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [`public.${t}`]);
  return r.rows[0]!.reg !== null;
};

describe.skipIf(!isTestDb)("upgrade migrations (DB)", () => {
  beforeAll(async () => {
    // The DB was loaded from schema.sql, which seeds every version — so the
    // starting point already has all migrations applied (the steady state a
    // fresh deploy boots into).
    await migrate();
  });

  it("is a no-op + idempotent when the DB is already current", async () => {
    const before = await seededCount();
    await migrate(); // second run
    await migrate(); // third run
    const after = await seededCount();
    expect(after).toBe(before);            // nothing re-applied, nothing duplicated
    expect(before).toBe(fileVersions.length); // schema.sql seeded every migration file
  });

  it("applies a missing migration incrementally on top of an existing DB", async () => {
    // Simulate an older deploy that predates 054: un-seed it so migrate() sees
    // it as unapplied and runs it again. We un-seed rather than DROP the table
    // because integration files share one DB and may run in parallel — touching
    // schema_migrations is invisible to other tests, whereas dropping a live
    // table would race them. 054's SQL is CREATE TABLE IF NOT EXISTS, so the
    // re-apply is safe and exercises the real apply-and-record upgrade path.
    expect(await tableExists("event_reviews")).toBe(true);
    await q(`DELETE FROM schema_migrations WHERE version = '054_event_reviews'`);
    expect(await isSeeded("054_event_reviews")).toBe(false);

    await migrate(); // upgrade: the unseeded migration is re-applied + recorded

    expect(await isSeeded("054_event_reviews")).toBe(true);   // convergence: recorded
    expect(await tableExists("event_reviews")).toBe(true);    // its DDL ran without error

    // Re-running stays a no-op (no double-apply error on the just-applied one).
    await migrate();
    expect(await isSeeded("054_event_reviews")).toBe(true);
  });

  it("always reconciles the default workspace (fresh-deploy seed gap)", async () => {
    // migrate() ends by ensuring the single-tenant default workspace exists —
    // schema.sql is schema-only, so without this a fresh volume would 500 on
    // getWorkspaceId(). Idempotent: present after migrate(), exactly one.
    const r = await q<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces WHERE slug = 'default'`);
    expect(Number(r.rows[0]!.n)).toBe(1);
  });
});

// Fresh-install verification: the 001→NNN chain must run on a TRULY EMPTY
// database — no schema.sql initdb load. This is the path every non-compose
// deploy (and every new contributor) hits; it rotted silently because compose
// pre-loads schema.sql and migrate() then no-ops. Regression guard for the
// 006 fix (collection_schemas existed only in schema.sql) and for any future
// migration that references a table a LATER migration creates.
describe.skipIf(!isTestDb)("migrations from an empty database (DB)", () => {
  const scratchDb = `onden_mig_scratch_${process.pid}`;
  let scratch: pg.Pool;

  beforeAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`);
    await pool.query(`CREATE DATABASE ${scratchDb}`);
    const url = new URL(DB);
    url.pathname = `/${scratchDb}`;
    scratch = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    // pool.end() resolves before its clients' sockets have closed, so the
    // forced DROP can terminate one mid-close; its "terminating connection"
    // error then reaches the pool. Expected here, not a test failure.
    scratch?.on("error", () => {});
    await scratch?.end();
    await pool.query(`DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`);
  });

  it.skipIf(needsPostgresServer)("applies every migration in order with no forward references", async () => {
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
      const sql = readFileSync(resolve(migrationsDir, f), "utf-8");
      try {
        await scratch.query(sql);
      } catch (e) {
        throw new Error(`migration ${f} failed on an empty database: ${(e as Error).message}`);
      }
    }

    // The end state carries the load-bearing tables (spot-check, not a full
    // schema diff — schemaDrift.test.ts guards snapshot/migration sync).
    for (const t of ["workspaces", "content_nodes", "domain_events", "outbox", "node_positions", "event_reviews"]) {
      const r = await scratch.query(`SELECT to_regclass($1) AS reg`, [`public.${t}`]);
      expect(r.rows[0].reg, `table ${t} should exist after a from-empty migrate`).not.toBeNull();
    }
  });
});

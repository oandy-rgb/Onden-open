// Building a Postgres test database from db/schema.sql and the migrations newer than it: what the suite's globalSetup does to the
// shared database, and what a test that needs databases of its own (stampedSnapshotTwoProcess) does to each of them.
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { portableMigrationSql } from "../../dbMigrations.js";

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db");

/** schema.sql is pg_dump output; drop its psql-only `\restrict` lines. */
async function schemaSql(): Promise<string> {
  const text = await readFile(resolve(dbDir, "schema.sql"), "utf-8");
  return text.split("\n").filter((line) => !line.startsWith("\\")).join("\n");
}

/** What a server needs of the SQL when it is older than the one the dump was made on, or lacks pgroonga (a developer's own
 *  Postgres): the production SQL otherwise, unchanged. On the servers CI and production use this changes nothing. */
async function fitToServer(c: pg.Client): Promise<(sql: string) => string> {
  const version = Number((await c.query("SHOW server_version_num")).rows[0].server_version_num);
  const hasGroonga = (await c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'pgroonga'")).rowCount! > 0;
  return (sql) => {
    let out = version < 170000 ? sql.replace(/^SET transaction_timeout = 0;$/gm, "") : sql;
    if (!hasGroonga) out = portableMigrationSql(out).replace(/^COMMENT ON EXTENSION (pgroonga|age|pg_stat_statements)[^;]*;$/gm, "");
    return out;
  };
}

/** Apply migrations newer than the snapshot, the way db.ts migrate() does. */
async function applyPendingMigrations(c: pg.Client, fit: (sql: string) => string): Promise<void> {
  const dir = resolve(dbDir, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await c.query<{ version: string }>("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    await c.query("BEGIN");
    await c.query(fit(await readFile(resolve(dir, file), "utf-8")));
    await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    await c.query("COMMIT");
  }
}

/** The empty database `c` is connected to, built up to the current schema; `withSchema` false when it already has the snapshot. */
export async function buildDatabase(c: pg.Client, withSchema = true): Promise<void> {
  const fit = await fitToServer(c);
  if (withSchema) await c.query(fit(await schemaSql()));
  await applyPendingMigrations(c, fit);
}

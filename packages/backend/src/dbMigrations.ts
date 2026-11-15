// Where migration SQL comes from, and the edits a database without the
// production extensions needs. db.ts migrate() is the only caller.
//
// Node reads db/migrations/*.sql next to the package. A host without a file
// system (browser worker, desktop shell with embedded SQL) installs its own
// source with useMigrationSource() before the first migrate().

import { nodeBuiltin } from "./nodeBuiltins.js";

export type MigrationFile = { version: string; sql: string };
type FsPromises = typeof import("node:fs/promises");

let source: (() => Promise<MigrationFile[]>) | null = null;
export function useMigrationSource(next: () => Promise<MigrationFile[]>): void {
  source = next;
}

async function readMigrationDirectory(): Promise<MigrationFile[]> {
  const fs = nodeBuiltin<FsPromises>("node:fs/promises");
  if (!fs) throw new Error("no migration source: not running on Node, call useMigrationSource() first");
  const dir = new URL("../db/migrations/", import.meta.url);
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => ({
    version: name.replace(/\.sql$/, ""),
    sql: await fs.readFile(new URL(name, dir), "utf-8"),
  })));
}

export function listMigrations(): Promise<MigrationFile[]> {
  return (source ?? readMigrationDirectory)();
}

/** The migrations as a database without age, pgroonga and pg_stat_statements can run them: those
 *  extensions (and the pgroonga index) are dropped; pg_trgm replaces pgroonga for search
 *  (services/textSearch.ts). Everything else is the production SQL, unchanged. */
export function portableMigrationSql(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS (age|pgroonga|pg_stat_statements)[^;]*;/gi, "")
    .replace(/CREATE INDEX[^;]*USING pgroonga[^;]*;/gi, "")
    .replace(/LOAD 'age';?/gi, "")
    .replace(/SET search_path[^;]*ag_catalog[^;]*;/gi, "");
}

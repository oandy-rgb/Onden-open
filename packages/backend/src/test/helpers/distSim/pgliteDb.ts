// A SyncDb over a bare PGlite carrying only the sync tables (migration 173): cheap enough to open one per node.
// The full-schema check (migration applies on a fully migrated database) is in distributedSyncMigration.integration.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { SyncDb } from "../../../distributedSync/types.js";

export const MIGRATION_SQL = readFileSync(fileURLToPath(new URL("../../../../db/migrations/173_distributed_sync.sql", import.meta.url)), "utf8");

type Queryable = Pick<PGlite | Transaction, "query">;

export function pgliteSyncDb(pg: PGlite | Transaction): SyncDb {
  const base: Queryable = pg;
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return (await base.query(sql, params)).rows as T[];
    },
    transaction<T>(fn: (tx: SyncDb) => Promise<T>): Promise<T> {
      // Inside a transaction already (PGlite has no nested ones): join it.
      if (!("transaction" in pg)) return fn(pgliteSyncDb(pg));
      return (pg as PGlite).transaction((tx) => fn(pgliteSyncDb(tx)));
    },
  };
}

export async function openSyncPglite(dump?: Blob | File): Promise<PGlite> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dump ? { loadDataDir: dump } : undefined);
  await pg.waitReady;
  if (!dump) await pg.exec(MIGRATION_SQL);
  return pg;
}

export const resetSyncTables = (pg: PGlite): Promise<unknown> =>
  pg.exec("TRUNCATE ds_ops, ds_rejections, ds_peers, ds_node RESTART IDENTITY");

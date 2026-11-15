// The engine's SyncDb over the server's own database handle (dbKysely.ts `db`, which runs on q()).
// Inside withTransaction() it joins that transaction, so an ingest, the projection it causes and the events they write commit or
// roll back as one (docs/architecture/distributed-sync.md §3.1). The engine's own SQL stays inside the engine; this only carries it.
import { CompiledQuery } from "kysely";
import { withTransaction } from "../../db.js";
import { db } from "../../dbKysely.js";
import type { SyncDb } from "../types.js";

export const qSyncDb: SyncDb = {
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await db.executeQuery<T>(CompiledQuery.raw(sql, params))).rows as T[];
  },
  transaction<T>(fn: (tx: SyncDb) => Promise<T>): Promise<T> {
    return withTransaction(() => fn(qSyncDb));
  },
};

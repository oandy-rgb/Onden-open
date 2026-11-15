// PGlite (Postgres compiled to WASM) behind the same few methods db.ts uses from
// `pg.Pool`: query, connect, on, end. db.ts is the only importer.
//
// PGlite has ONE connection, and the backend assumes it can hold a client in a
// transaction while other code runs queries through the pool. On real Postgres
// those are two connections; here the second would wait for the first forever.
// Two rules keep that from deadlocking:
//   1. connect() is a FIFO mutex: whoever holds the client owns the database
//      until release(), so two requests' transactions never interleave.
//   2. pool.query() made from inside an open transaction (`ambientClient()`
//      answers with it) runs ON that transaction's client. A write the code
//      meant to commit separately (blobs.putBlob) therefore commits or rolls
//      back with the transaction; those writes are idempotent by content hash.
// Session-level advisory locks never block here (one session), and db.ts
// withLeaderLock() skips them. Design notes: docs/architecture/portable-backend.md.

import type { PGlite, Results } from "@electric-sql/pglite";
import type pg from "pg";

export type PgliteSettings = {
  /** `memory://`, a directory (Node), `idb://name` or `opfs-ahp://name` (browser). */
  dataDir: string;
  /** A tar from dumpDataDir(): the first open starts from it instead of an empty database. */
  loadDataDir?: () => Promise<Blob | undefined>;
  /** How long connect() may wait for the connection before failing (a stuck holder, not a busy one). */
  connectTimeoutMs: number;
  /** The client of the transaction the caller is inside, if any (db.ts passes its context slot). */
  ambientClient: () => PoolClientLike | undefined;
  /** Called when pool.query() runs inside an open transaction (see query()); throwing refuses it (tests). */
  onPoolQueryInTransaction?: (text: string) => void;
};

type QueryConfig = { text: string; values?: unknown[] };
export type PoolClientLike = {
  query: (text: string | QueryConfig, params?: unknown[]) => Promise<Pick<Results, "rows" | "fields"> & { rowCount: number | null; command: string }>;
  release: (err?: Error) => void;
};

export async function openPglite(settings: Pick<PgliteSettings, "dataDir" | "loadDataDir">): Promise<PGlite> {
  const [{ PGlite, types }, { vector }, { pgcrypto }, { pg_trgm }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
    import("@electric-sql/pglite/contrib/pgcrypto"),
    import("@electric-sql/pglite/contrib/pg_trgm"),
  ]);
  const start = await settings.loadDataDir?.();
  const db = new PGlite(settings.dataDir, {
    extensions: { vector, pgcrypto, pg_trgm },
    ...(start ? { loadDataDir: start } : {}),
    // Same as `pg`: bigint and numeric come back as strings (event cursors, parseBigintId).
    parsers: { [types.INT8]: (v: string) => v, [types.NUMERIC]: (v: string) => v },
  });
  await db.waitReady;
  // db.ts sets TimeZone=UTC for every pooled session; there is one session here.
  await db.exec("SET TimeZone = 'UTC'");
  return db;
}

/** FIFO lock whose waiters can give up, so a stuck holder surfaces as an error instead of a hang. */
class Mutex {
  private held = false;
  private readonly waiters: Array<(release: () => void) => void> = [];
  acquire(timeoutMs: number): Promise<() => void> {
    const release = () => {
      const next = this.waiters.shift();
      if (next) next(release);
      else this.held = false;
    };
    if (!this.held) {
      this.held = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const grant = (r: () => void) => { clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(grant), 1);
        reject(new Error("timeout exceeded when trying to connect"));
      }, timeoutMs);
      this.waiters.push(grant);
    });
  }
}

export class PglitePool {
  private opened: Promise<PGlite> | null = null;
  private readonly mutex = new Mutex();
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  // pg.Pool counters some diagnostics read.
  totalCount = 1;
  idleCount = 0;
  waitingCount = 0;

  constructor(private readonly settings: PgliteSettings) {}

  /** The database handle, opened on first use. */
  database(): Promise<PGlite> {
    this.opened ??= openPglite(this.settings);
    return this.opened;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  listenerCount(event: string): number { return this.listeners.get(event)?.length ?? 0; }
  emit(event: string, ...args: unknown[]): boolean {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    return this.listenerCount(event) > 0;
  }

  async connect(): Promise<PoolClientLike> {
    this.waitingCount++;
    let release: () => void;
    try { release = await this.mutex.acquire(this.settings.connectTimeoutMs); } finally { this.waitingCount--; }
    let released = false;
    return {
      query: (text, params) => {
        if (released) return Promise.reject(new Error("Client has already been released"));
        return this.run(text, params);
      },
      release: () => { if (!released) { released = true; release(); } },
    };
  }

  async query(text: string | QueryConfig, params?: unknown[]): ReturnType<PoolClientLike["query"]> {
    const ambient = this.settings.ambientClient();
    if (ambient) {
      this.settings.onPoolQueryInTransaction?.(typeof text === "string" ? text : text.text);
      return ambient.query(text, params);
    }
    const client = await this.connect();
    try { return await client.query(text, params); } finally { client.release(); }
  }

  async end(): Promise<void> {
    if (!this.opened) return;
    const db = await this.opened;
    this.opened = null;
    if (!db.closed) await db.close();
  }

  private async run(text: string | QueryConfig, params?: unknown[]): ReturnType<PoolClientLike["query"]> {
    const db = await this.database();
    const sql = typeof text === "string" ? text : text.text;
    const values = params ?? (typeof text === "string" ? undefined : text.values);
    // pg runs a parameterless string on the simple protocol, which allows several statements
    // (migration files); PGlite's query() is always the extended protocol, which does not.
    const result = values === undefined ? (await db.exec(sql)).at(-1) ?? { rows: [], fields: [], command: "", rowCount: 0, affectedRows: 0 }
      : await db.query(sql, values);
    return { rows: result.rows as never[], fields: result.fields, command: result.command ?? "", rowCount: result.rowCount ?? result.affectedRows ?? null };
  }
}

/** PglitePool answers the part of pg.Pool that db.ts and better-auth's Kysely dialect call. */
export function asPgPool(pool: PglitePool): pg.Pool {
  return pool as unknown as pg.Pool;
}

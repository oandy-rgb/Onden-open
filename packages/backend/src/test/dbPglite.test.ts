// The single-connection stand-in for pg.Pool (dbPglite.ts), driven directly with its own in-memory
// database: independent of ONDEN_DB_DRIVER, so it runs in every environment.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PglitePool, type PoolClientLike } from "../dbPglite.js";

let ambient: PoolClientLike | undefined;
let pool: PglitePool;

beforeAll(async () => {
  pool = new PglitePool({ dataDir: "memory://", connectTimeoutMs: 300, ambientClient: () => ambient });
  await pool.query("CREATE TABLE t (id int PRIMARY KEY, label text, big bigint, doc jsonb)");
});
afterAll(async () => { await pool.end(); });

describe("PglitePool as pg.Pool", () => {
  it("returns pg-shaped results: bigint and numeric as strings, rowCount, command", async () => {
    const ins = await pool.query("INSERT INTO t VALUES ($1, $2, $3, $4)", [40, "a", "9007199254740993", { k: [1, 2] }]);
    expect(ins).toMatchObject({ rowCount: 1, command: "INSERT" });
    const sel = await pool.query("SELECT big, doc, 1.5::numeric AS n FROM t WHERE id = 40");
    expect(sel.rows[0]).toEqual({ big: "9007199254740993", doc: { k: [1, 2] }, n: "1.5" });
    expect(sel.rowCount).toBe(1);
  });

  it("runs several statements without parameters, as pg's simple protocol does (migration files)", async () => {
    await pool.query("INSERT INTO t (id, label) VALUES (10, 'x'); INSERT INTO t (id, label) VALUES (11, 'y'); UPDATE t SET label = 'z' WHERE id = 11");
    const rows = (await pool.query("SELECT label FROM t WHERE id IN (10, 11) ORDER BY id")).rows;
    expect(rows.map((r) => (r as { label: string }).label)).toEqual(["x", "z"]);
  });

  it("surfaces Postgres error codes the way pg does", async () => {
    await pool.query("INSERT INTO t (id) VALUES (30)");
    await expect(pool.query("INSERT INTO t (id) VALUES (30)")).rejects.toMatchObject({ code: "23505" });
  });

  it("a client holds the only connection: a second connect() waits for release, in order", async () => {
    const first = await pool.connect();
    const order: string[] = [];
    const second = pool.connect().then((c) => { order.push("second"); c.release(); });
    const third = pool.connect().then((c) => { order.push("third"); c.release(); });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);
    first.release();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("a waiter gives up with pg's timeout message instead of hanging when the holder never lets go", async () => {
    const holder = await pool.connect();
    await expect(pool.connect()).rejects.toThrow("timeout exceeded when trying to connect");
    holder.release();
    (await pool.connect()).release(); // the abandoned waiter did not leave the lock stuck
  });

  it("pool.query inside an open transaction runs on that transaction (no second connection to deadlock on)", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    ambient = client;
    try {
      await client.query("INSERT INTO t (id, label) VALUES (20, 'in-tx')");
      // The code under test calls pool.query, not client.query, like blobs.putBlob does.
      const seen = await pool.query("SELECT label FROM t WHERE id = 20");
      expect(seen.rows).toHaveLength(1);
      await pool.query("INSERT INTO t (id, label) VALUES (21, 'also-in-tx')");
    } finally {
      ambient = undefined;
    }
    await client.query("ROLLBACK");
    client.release();
    // Both writes rolled back with the transaction.
    expect((await pool.query("SELECT 1 FROM t WHERE id IN (20, 21)")).rows).toHaveLength(0);
  });

  it("COMMIT of an aborted transaction answers ROLLBACK, which db.ts turns into a failure", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await expect(client.query("SELECT nope")).rejects.toMatchObject({ code: "42703" });
    expect((await client.query("COMMIT")).command).toBe("ROLLBACK");
    client.release();
  });

  it("a released client cannot be used again", async () => {
    const client = await pool.connect();
    client.release();
    await expect(client.query("SELECT 1")).rejects.toThrow(/released/);
    client.release(); // twice is harmless
    (await pool.connect()).release();
  });
});

// Real pg throws "Cannot use a pool after calling end on the pool". Before: a query after end() opened a SECOND PGlite
// instance (an empty database for memory://, a second handle on the same directory on disk), so a job that outlived the
// pool wrote into a database nobody closes, with no error.
describe("PglitePool after end()", () => {
  const settings = { connectTimeoutMs: 300, ambientClient: () => undefined };
  let dir = "";
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("rejects query, connect and database(), naming the call and keeping the caller's stack", async () => {
    const ended = new PglitePool({ dataDir: "memory://", ...settings });
    await ended.query("CREATE TABLE t (id int)");
    await ended.end();
    await expect(ended.query("SELECT 1")).rejects.toThrow(/pool was ended.*query\(\)/);
    await expect(ended.connect()).rejects.toThrow(/pool was ended.*connect\(\)/);
    await expect(ended.database()).rejects.toThrow(/pool was ended.*database\(\)/);
    const err = await ended.query("SELECT 1").then(() => new Error("did not reject"), (e: Error) => e);
    expect(err.stack).toContain("dbPglite.test.ts"); // the late caller, not only the pool's internals
    expect((err.cause as Error).stack).toContain("dbPglite.test.ts"); // and who ended it
  });

  it("an in-flight client that outlives end() is refused instead of reopening the database", async () => {
    const ended = new PglitePool({ dataDir: "memory://", ...settings });
    const client = await ended.connect();
    await client.query("SELECT 1");
    await ended.end();
    await expect(client.query("SELECT 1")).rejects.toThrow(/pool was ended/);
    client.release();
  });

  it("ending a pool that was never opened still refuses later use, and a second end() is harmless", async () => {
    const ended = new PglitePool({ dataDir: "memory://", ...settings });
    await ended.end();
    await ended.end();
    await expect(ended.query("SELECT 1")).rejects.toThrow(/pool was ended/);
  });

  it("writes nothing to the data directory after end()", async () => {
    dir = await mkdtemp(join(tmpdir(), "pglite-ended-"));
    const data = join(dir, "data");
    const ended = new PglitePool({ dataDir: data, ...settings });
    await ended.query("CREATE TABLE t (id int)");
    await ended.end();
    const before = (await readdir(data)).sort();
    await expect(ended.query("INSERT INTO t VALUES (1)")).rejects.toThrow(/pool was ended/);
    expect((await readdir(data)).sort()).toEqual(before);
    // Starting again is a new pool on purpose, and it sees what the first one committed.
    const again = new PglitePool({ dataDir: data, ...settings });
    expect((await again.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 't'")).rows[0]).toEqual({ n: 1 });
    await again.end();
  });
});

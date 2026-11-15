// db.ts on whichever engine this run uses (real Postgres, or PGlite with ONDEN_DB_DRIVER=pglite):
// the contract everything above it relies on, stated once. Runs on both.
import { describe, it, expect } from "vitest";
import { dbDriver, pool, q, queryOnSeparateConnection, withTransaction, withSavepoint, withLeaderLock, inTransaction } from "../db.js";
import { afterCommit } from "../spine/txHooks.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB);

describe.skipIf(!isTestDb)(`db.ts on ${dbDriver}`, () => {
  it("a pool.query made inside a transaction does not wait for the transaction (blobs.putBlob's shape)", async () => {
    await q(`CREATE TEMP TABLE IF NOT EXISTS driver_probe (n int)`).catch(() => {});
    const result = await withTransaction(async () => {
      expect(inTransaction()).toBe(true);
      const inside = await queryOnSeparateConnection("SELECT 1 AS one");
      return inside.rows[0];
    });
    expect(result).toEqual({ one: 1 });
  });

  it("commit hooks run after COMMIT, rollback drops them", async () => {
    const seen: string[] = [];
    await withTransaction(async () => { afterCommit(() => seen.push("committed")); });
    await expect(withTransaction(async () => { afterCommit(() => seen.push("rolled-back")); throw new Error("x"); })).rejects.toThrow("x");
    expect(seen).toEqual(["committed"]);
  });

  it("a savepoint failure leaves the surrounding transaction usable", async () => {
    const value = await withTransaction(async () => {
      await expect(withSavepoint(async () => { await q("SELECT nope_column"); })).rejects.toMatchObject({ code: "42703" });
      return (await q<{ v: number }>("SELECT 5 AS v")).rows[0]!.v;
    });
    expect(value).toBe(5);
  });

  it("a swallowed SQL error does not turn into a successful commit", async () => {
    await expect(withTransaction(async () => {
      await q("SELECT nope_column").catch(() => {});
    })).rejects.toThrow();
  });

  it("withLeaderLock runs the work and returns its value", async () => {
    expect(await withLeaderLock({ key: 4_242_099_001 }, async () => (await q("SELECT 3 AS n")).rows[0])).toEqual({ held: true, value: { n: 3 } });
    expect(await withLeaderLock({ name: "driver-test" }, async () => "named")).toEqual({ held: true, value: "named" });
  });

  it.skipIf(dbDriver === "pglite")("a second instance does not run while the first holds the leader lock (Postgres only)", async () => {
    let inner: unknown;
    const outer = await withLeaderLock({ key: 4_242_099_002 }, async () => { inner = await withLeaderLock({ key: 4_242_099_002 }, async () => "x"); return "outer"; });
    expect(outer).toEqual({ held: true, value: "outer" });
    expect(inner).toEqual({ held: false });
  });
});

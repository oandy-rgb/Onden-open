// realPostgresAlso: 交易內的連線池讀在真 Postgres 是另一條連線，讀不到未提交的列；PGlite 靠守門才看得到
import { describe, expect, it } from "vitest";
import { dbDriver, pool, q, queryOnSeparateConnection, withTransaction } from "../db.js";

describe.skipIf(dbDriver !== "pglite")("pool.query inside a transaction (guard, PGlite)", () => {
  it("is refused; q() and queryOnSeparateConnection() are allowed", async () => {
    await withTransaction(async () => {
      await expect(pool.query("SELECT 1")).rejects.toThrow(/inside a transaction/);
      expect((await q("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
      expect((await queryOnSeparateConnection("SELECT 2 AS two")).rows[0]).toEqual({ two: 2 });
    });
  });
  it("is fine outside a transaction", async () => {
    expect((await pool.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
  });
});

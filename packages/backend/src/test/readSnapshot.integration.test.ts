import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q, withReadSnapshot, withTransaction } from "../db.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("read snapshot transaction contract", () => {
  let ws: string;
  beforeAll(async () => {
    ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('before',$1) RETURNING id", [randomUUID()])).rows[0].id;
  });
  afterAll(async () => { await q("DELETE FROM workspaces WHERE id=$1", [ws]); });
  const name = async () => (await q("SELECT name FROM workspaces WHERE id=$1", [ws])).rows[0].name;

  it.skipIf(needsSecondConnection)("q and nested transaction helpers keep the first snapshot across an external commit", async () => {
    await q("UPDATE workspaces SET name='before' WHERE id=$1", [ws]);
    await withReadSnapshot(async () => {
      expect(await name()).toBe("before");
      // Deliberately independent connection: emulate another request's commit.
      await pool.query("UPDATE workspaces SET name='after' WHERE id=$1", [ws]);
      expect(await name()).toBe("before");
      expect(await withTransaction(name)).toBe("before");
    });
    expect(await name()).toBe("after");
  });

  it("rejects accidental writes and releases the connection so a later write succeeds", async () => {
    await expect(withReadSnapshot(async () => {
      await q("UPDATE workspaces SET name='forbidden' WHERE id=$1", [ws]);
    })).rejects.toMatchObject({ code: "25006" });
    expect(await name()).not.toBe("forbidden");
    await withTransaction(async () => { await q("UPDATE workspaces SET name='allowed' WHERE id=$1", [ws]); });
    expect(await withReadSnapshot(name)).toBe("allowed");
  });

  it("does not silently downgrade the guarantee by joining an outer write or read transaction", async () => {
    let ran = false;
    for (const outer of [withTransaction, withReadSnapshot]) {
      await outer(async () => {
        expect(() => withReadSnapshot(async () => { ran = true; })).toThrow("outside an existing transaction");
        expect(await name()).toBeTypeOf("string");
      });
    }
    expect(ran).toBe(false);
  });

  it("does not turn an aborted transaction into a successful response when SQL errors were caught", async () => {
    await expect(withReadSnapshot(async () => {
      try { await q("SELECT 1 / 0"); } catch { /* caller mistakenly catches SQL failure */ }
      return "must not be delivered";
    })).rejects.toThrow("transaction was aborted before commit");
    expect(await withReadSnapshot(name)).toBeTypeOf("string");
  });
});

import { describe, expect, it, vi } from "vitest";
import { pool, q, withTransaction } from "../db.js";
import { afterCommit } from "../spine/txHooks.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";

// This suite only creates transaction-local tables; never run on a user DB.
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("recoverable event transaction", () => {
  it("rolls back a rejected unit while its enclosing batch can still commit", async () => {
    const accepted = vi.fn();
    const rejected = vi.fn();
    await withTransaction(async () => {
      await q("CREATE TEMP TABLE event_unit_probe (value text) ON COMMIT DROP");
      await q("INSERT INTO event_unit_probe VALUES ('before')");
      await expect(withEventTransaction("savepoint-test", async () => {
        await q("INSERT INTO event_unit_probe VALUES ('rejected')");
        afterCommit(rejected);
        throw new Error("domain conflict");
      })).rejects.toThrow("domain conflict");
      await withEventTransaction("savepoint-test", async () => {
        await q("INSERT INTO event_unit_probe VALUES ('accepted')");
        afterCommit(accepted);
      });
      expect((await q("SELECT value FROM event_unit_probe ORDER BY value")).rows)
        .toEqual([{ value: "accepted" }, { value: "before" }]);
      expect(accepted).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
    });
    expect(accepted).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
  });

  it.skipIf(needsSecondConnection)("discards successful descendant hooks when a containing unit rejects", async () => {
    const descendant = vi.fn();
    await withTransaction(async () => {
      await q("CREATE TEMP TABLE event_unit_probe (value text) ON COMMIT DROP");
      await expect(withEventTransaction("savepoint-test", async () => {
        await withEventTransaction("savepoint-test", async () => {
          await q("INSERT INTO event_unit_probe VALUES ('child')");
          afterCommit(descendant);
        });
        throw new Error("parent conflict");
      })).rejects.toThrow("parent conflict");
      expect((await q("SELECT * FROM event_unit_probe")).rows).toEqual([]);
    });
    expect(descendant).not.toHaveBeenCalled();
  });

  it("does not notify successful units if the outer transaction rolls back", async () => {
    const notified = vi.fn();
    await expect(withTransaction(async () => {
      await withEventTransaction("savepoint-test", async () => { afterCommit(notified); });
      throw new Error("batch failed");
    })).rejects.toThrow("batch failed");
    expect(notified).not.toHaveBeenCalled();
  });

  it("recovers the surrounding transaction after a SQL error", async () => {
    await withTransaction(async () => {
      await q("CREATE TEMP TABLE event_unit_probe (value integer PRIMARY KEY) ON COMMIT DROP");
      await q("INSERT INTO event_unit_probe VALUES (1)");
      await expect(withEventTransaction("savepoint-test", async () => {
        await q("INSERT INTO event_unit_probe VALUES (2)");
        await q("INSERT INTO event_unit_probe VALUES (1)");
      })).rejects.toMatchObject({ code: "23505" });
      await q("INSERT INTO event_unit_probe VALUES (3)");
      expect((await q("SELECT value FROM event_unit_probe ORDER BY value")).rows)
        .toEqual([{ value: 1 }, { value: 3 }]);
    });
  });

  it.skipIf(needsSecondConnection)("holds the shared event lock until the outer commit and releases it afterwards", async () => {
    const workspace = crypto.randomUUID();
    const contender = await pool.connect();
    const tryLock = async (): Promise<boolean> => {
      await contender.query("BEGIN");
      try {
        const { rows } = await contender.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [`event-append:${workspace}`],
        );
        return rows[0]!.locked;
      } finally {
        await contender.query("ROLLBACK");
      }
    };
    try {
      await withTransaction(async () => {
        await withEventTransaction(workspace, async () => { expect(await tryLock()).toBe(false); });
        expect(await tryLock()).toBe(false);
      });
      expect(await tryLock()).toBe(true);
    } finally {
      contender.release();
    }
  });
});

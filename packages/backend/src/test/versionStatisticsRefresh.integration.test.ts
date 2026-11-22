// A History read triggers the version tables' statistics refresh (services/history/storedVersions.ts keepVersionStatisticsCurrent). The property (review of PR #1948,
// round 3): the refresh NEVER runs on anyone else's transaction or connection, and its failure reaches no user's operation.
// realPostgresAlso: a server has the connection pool the refresh takes its own connection from
import { afterEach, describe, expect, it, vi } from "vitest";
import { pool, withTransaction, q } from "../db.js";
import { keepVersionStatisticsCurrent } from "../services/history/storedVersions.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const TEN_MINUTES_ON = 11 * 60_000;
let clock = Date.now();
/** Each case starts after the throttle (one refresh in ten minutes per process) has run out. */
const nextWindow = () => { clock += TEN_MINUTES_ON; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock); };
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe.skipIf(!isTestDatabase())("the version statistics refresh stays off other people's transactions and connections", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("inside a transaction (a rewind reads under the event lock) it runs nothing on it", async () => {
    nextWindow();
    await withTransaction(async () => {
      const statements = vi.spyOn(pool, "query");
      keepVersionStatisticsCurrent();
      await settle();
      expect(statements, "nothing queued on the pool").not.toHaveBeenCalled();
      await q("SELECT 1"); // the transaction is still usable, and the next plain read does the refresh
    });
    const statements = vi.spyOn(pool, "query");
    keepVersionStatisticsCurrent();
    await vi.waitFor(() => expect(statements, "the next read outside a transaction refreshes, on the pool").toHaveBeenCalled(), { timeout: 10_000 });
  });

  it("a refresh that fails reaches no one: nothing thrown, no unhandled rejection", async () => {
    nextWindow();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      vi.spyOn(pool, "query").mockRejectedValue(new Error("no connection") as never);
      expect(() => keepVersionStatisticsCurrent()).not.toThrow();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});

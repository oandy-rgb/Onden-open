// A drain that throws while the database closes: the error reaches the caller of pool.end() and the pool ends anyway.
// Before: the pool was never ended (and the failed promise was remembered). Ends the pool: one scenario per file.

import { describe, expect, it } from "vitest";
import { dbDriver, pglite, pool, q } from "../db.js";
import { onBeforePoolEnd } from "../dbClose.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

// Gated like every integration file: it opens a database (PGlite or the _test one) and ends it; without one it is skipped by name.
describe.skipIf(!isTestDatabase())("pool.end() when a registered drain throws", () => {
  it("rejects with that error and still ends the pool", async () => {
    await q("SELECT 1"); // PGlite opens its database on first use; ending it is what we look for
    onBeforePoolEnd("failing", { pending: () => 1, drain: async () => { throw new Error("drain failed"); } });

    await expect(pool.end()).rejects.toThrow("drain failed");

    const ended = dbDriver === "pglite"
      ? (pglite as unknown as { opened: unknown }).opened === null
      : (pool as unknown as { ended: boolean }).ended;
    expect(ended).toBe(true);
  });
});

// Every table of a migrated database has a class in spine/syncClasses.ts: a table added without answering
// "what happens on two devices that were both offline?" fails here, by name.
import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { SYNC_CLASSES } from "../spine/syncClasses.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("every table is classified", () => {
  afterAll(async () => { await pool.end(); });

  it("the database holds no table that spine/syncClasses.ts does not name", async () => {
    const tables = (await q<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
    expect(tables.filter((t) => !(t in SYNC_CLASSES)), "add each table to SYNC_CLASSES with the class it belongs to").toEqual([]);
  });
});

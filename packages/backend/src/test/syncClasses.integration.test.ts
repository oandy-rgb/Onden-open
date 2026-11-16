// Every table of a migrated database has a class in spine/syncClasses.ts: a table added without answering
// "what happens on two devices that were both offline?" fails here, by name.
import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { SNAPSHOT_TABLES, SYNC_CLASSES } from "../spine/syncClasses.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("every table is classified", () => {
  afterAll(async () => { await pool.end(); });

  it("the database holds no table that spine/syncClasses.ts does not name", async () => {
    const tables = (await q<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
    expect(tables.filter((t) => !(t in SYNC_CLASSES)), "add each table to SYNC_CLASSES with the class it belongs to").toEqual([]);
  });

  it("every stamped table says what a snapshot does with it, and the tables a snapshot carries are exactly the ones snapshotTables.json describes", () => {
    const silent = Object.entries(SYNC_CLASSES).filter(([, e]) => e.class === "stamped" && !e.snapshot).map(([t]) => t);
    expect(silent, "say rows / genesis / no (with snapshotNote) in spine/syncClasses.json").toEqual([]);
    const withoutWhy = Object.entries(SYNC_CLASSES).filter(([, e]) => e.snapshot === "no" && !e.snapshotNote).map(([t]) => t);
    expect(withoutWhy, "a table that is not carried says why in snapshotNote").toEqual([]);
    expect(SNAPSHOT_SPECS.map((s) => s.table).sort()).toEqual(Object.values(SNAPSHOT_TABLES).flat().sort());
  });

  it("every carried table exists, and a stamped one is read with the stamps its triggers write", async () => {
    for (const spec of SNAPSHOT_SPECS) {
      const columns = (await q<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [spec.table])).rows.map((r) => r.c);
      expect(columns.length, `${spec.table} does not exist`).toBeGreaterThan(0);
      for (const c of [...(spec.exclude ?? []), ...(spec.deferred ?? []), ...spec.pk]) expect(columns, `${spec.table}.${c}`).toContain(c);
      const entry = SYNC_CLASSES[spec.table]!;
      expect(Boolean(spec.stamps), `${spec.table}: stamps are read exactly for the wired tables`).toBe(entry.snapshot === "rows");
    }
    // every label a wired table's trigger files stamps under is one the table's entry reads (no stamp left behind)
    const labels = (await q<{ t: string }>(`SELECT DISTINCT table_name AS t FROM sync_stamps`)).rows.map((r) => r.t).filter((t) => SYNC_CLASSES[t.split(".")[0]!]?.snapshot === "rows");
    const read = new Set(SNAPSHOT_SPECS.flatMap((s) => (s.stamps ?? []).map((d) => d.label)));
    expect(labels.filter((l) => !read.has(l))).toEqual([]);
  });
});

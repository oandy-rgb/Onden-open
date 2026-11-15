// 舊程式碰到新資料庫要拒絕啟動（升級／回退安全）。純函式部分不需要 Postgres；
// 資料庫部分只在 *_test 資料庫執行。
import { describe, it, expect, afterEach } from "vitest";
import { DatabaseNewerThanCodeError, migrate, q, unknownMigrationVersions } from "../db.js";

describe("unknownMigrationVersions", () => {
  it("is empty when the database is current or behind (a normal upgrade)", () => {
    expect(unknownMigrationVersions(["001_a", "002_b"], ["001_a", "002_b"])).toEqual([]);
    expect(unknownMigrationVersions(["001_a"], ["001_a", "002_b", "003_c"])).toEqual([]);
    expect(unknownMigrationVersions([], ["001_a"])).toEqual([]);
  });

  it("lists versions the code has no file for, sorted", () => {
    expect(unknownMigrationVersions(["001_a", "135_z", "134_y"], ["001_a"])).toEqual(["134_y", "135_z"]);
  });
});

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const FUTURE = "999_from_a_newer_release";

describe.skipIf(!isTestDb)("migrate() against a database newer than this build (DB)", () => {
  afterEach(async () => {
    await q(`DELETE FROM schema_migrations WHERE version = $1`, [FUTURE]);
  });

  it("refuses to run and names the unknown version", async () => {
    await migrate();
    await q(`INSERT INTO schema_migrations (version) VALUES ($1)`, [FUTURE]);
    await expect(migrate()).rejects.toMatchObject({
      name: "DatabaseNewerThanCodeError",
      unknownVersions: [FUTURE],
    });
    await expect(migrate()).rejects.toBeInstanceOf(DatabaseNewerThanCodeError);
  });

  it("still migrates normally when the database is behind", async () => {
    await migrate();
    const { rows } = await q<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`);
    await q(`DELETE FROM schema_migrations WHERE version = $1`, [rows[0]!.version]);
    await expect(migrate()).resolves.toBeUndefined();
    const again = await q(`SELECT 1 FROM schema_migrations WHERE version = $1`, [rows[0]!.version]);
    expect(again.rows.length).toBe(1);
  });
});

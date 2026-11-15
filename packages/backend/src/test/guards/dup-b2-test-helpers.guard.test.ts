// 拋棄式資料庫（_test／_bench／_drill）的名稱與本機檢查只有一個入口：
// scripts/lib/disposableDb.mjs（docs/research/dup-patterns-2026-10-30-render.md S1）。
// 允許清單：其他檔案出現自己寫的名稱正規式就失敗。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { assertDisposableDatabase, isDisposableDatabase } from "../../../../../scripts/lib/disposableDb.mjs";
import { isTestDatabase } from "../helpers/testDatabase.js";

const ROOT = join(import.meta.dirname, "../../../../..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(path, ext);
    return ext.test(e.name) ? [path] : [];
  });
}
const scanned = [
  ...files(join(ROOT, "scripts"), /\.(mjs|ts|sh)$/),
  ...files(join(ROOT, "packages/backend/scripts"), /\.(ts|sh)$/),
  ...files(join(ROOT, "packages/backend/src"), /\.ts$/),
].map((path) => ({ file: relative(ROOT, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

const NAME_CHECK = /_(?:test|bench|drill)\$/;
const INLINE_GATE = /new URL\(process\.env\.DATABASE_URL \?\? ""\)\.pathname/;

// 例外（附原因）；只准減少。
const NAME_CHECK_OWNERS = [
  "scripts/lib/disposableDb.mjs", // 唯一的 TS／JS 實作
  "scripts/restore-drill.sh", // bash 無法 import，同規則的對應檢查
  "packages/backend/scripts/test-isolated.sh", // 同上
  "packages/backend/src/test/testDatabaseGate.test.ts", // 釘住每個整合測試檔的閘門寬度
  "packages/backend/src/test/guards/dup-b2-test-helpers.guard.test.ts",
  // 另一批進行中的 PR 也在改這兩檔，閘門先不動：
  "packages/backend/src/test/noteDuplicate.integration.test.ts",
  "packages/backend/src/test/tagModules.integration.test.ts",
];
// ratchet:list INLINE_GATE_EXCEPTIONS
const INLINE_GATE_EXCEPTIONS = [
  "packages/backend/src/test/noteDuplicate.integration.test.ts",
  "packages/backend/src/test/tagModules.integration.test.ts",
  "packages/backend/src/test/guards/dup-b2-test-helpers.guard.test.ts",
];

const offenders = (pattern: RegExp, allowed: string[]) =>
  scanned.filter((f) => !allowed.includes(f.file) && pattern.test(f.text)).map((f) => f.file);

describe("拋棄式資料庫護欄只有一個入口", () => {
  it("_test／_bench／_drill 名稱正規式只在 scripts/lib/disposableDb.mjs 與 bash 對應檢查", () => {
    expect(offenders(NAME_CHECK, NAME_CHECK_OWNERS)).toEqual([]);
  });

  it("整合測試用 isTestDatabase()，不自己解析 DATABASE_URL", () => {
    expect(offenders(INLINE_GATE, INLINE_GATE_EXCEPTIONS)).toEqual([]);
  });

  it("守門自我驗證：違規寫法會被抓到", () => {
    expect(NAME_CHECK.test("if (!/_bench$/.test(name))")).toBe(true);
    expect(NAME_CHECK.test("describe.skipIf(!/^\\/[^/]*_test$/.test(dbName))")).toBe(true);
    expect(NAME_CHECK.test("const isTest = isTestDatabase();")).toBe(false);
    expect(INLINE_GATE.test('const dbName = new URL(process.env.DATABASE_URL ?? "").pathname;')).toBe(true);
  });
});

describe("assertDisposableDatabase 的行為", () => {
  const url = (host: string, db: string) => `postgres://u:pw@${host}:5432/${db}`;

  it("名稱要以指定後綴結尾", () => {
    expect(isDisposableDatabase(url("localhost", "onden_test"), "test")).toBe(true);
    expect(isDisposableDatabase(url("localhost", "onden_test"), "bench")).toBe(false);
    expect(isDisposableDatabase(url("localhost", "onden"), "test")).toBe(false);
    expect(isDisposableDatabase(url("localhost", "onden_test_backup"), "test")).toBe(false);
    // 帳號名稱裡的 _test 不是資料庫名稱。
    expect(isDisposableDatabase("postgres://a_test:pw@localhost/onden", "test")).toBe(false);
  });

  it("localOnly 時遠端主機一律拒絕，壞網址與空值也拒絕", () => {
    expect(isDisposableDatabase(url("localhost", "x_drill"), "drill", { localOnly: true })).toBe(true);
    expect(isDisposableDatabase(url("127.0.0.1", "x_drill"), "drill", { localOnly: true })).toBe(true);
    expect(isDisposableDatabase(url("db.example.com", "x_drill"), "drill", { localOnly: true })).toBe(false);
    expect(isDisposableDatabase(url("db.example.com", "x_bench"), "bench")).toBe(true);
    expect(isDisposableDatabase("not a url", "test", { localOnly: true })).toBe(false);
    expect(isDisposableDatabase(undefined, "test")).toBe(false);
  });

  it("整合測試的閘門拒絕遠端主機上的 _test 資料庫（測試會 DROP 並重建它）", () => {
    expect(isTestDatabase(url("127.0.0.1", "onden_test"))).toBe(true);
    expect(isTestDatabase(url("prod-db.example.com", "onden_test"))).toBe(false);
  });

  it("assert 丟出的訊息不含連線密碼", () => {
    expect(() => assertDisposableDatabase(url("localhost", "onden"), "bench")).toThrow(/_bench/);
    try { assertDisposableDatabase(url("localhost", "onden"), "bench"); } catch (e) { expect(String(e)).not.toContain("pw"); }
  });
});

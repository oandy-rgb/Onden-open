// 舊備份含 Apache AGE；scripts/lib/strip-age.sed 讓它能還原到沒有 AGE 的映像
// （restore.sh 讀純 SQL 傾印，restore-drill.sh 讀 pg_restore -l 的目錄）。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SED = resolve(fileURLToPath(new URL("../../../../scripts/lib/strip-age.sed", import.meta.url)));
const strip = (text: string) => spawnSync("sed", ["-f", SED], { input: text, encoding: "utf8" }).stdout;

describe("strip-age.sed", () => {
  it("removes the age lines of a plain-SQL dump and keeps everything else", () => {
    const dump = [
      "DROP EXTENSION IF EXISTS age;",
      "DROP SCHEMA IF EXISTS ag_catalog;",
      "CREATE SCHEMA ag_catalog;",
      "CREATE EXTENSION IF NOT EXISTS age WITH SCHEMA ag_catalog;",
      "COMMENT ON EXTENSION age IS 'AGE database extension';",
      "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
      "COMMENT ON EXTENSION vector IS 'vector data type';",
      "CREATE TABLE public.page_views (storage integer, image text);",
      "",
    ].join("\n");
    expect(strip(dump)).toBe([
      "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
      "COMMENT ON EXTENSION vector IS 'vector data type';",
      "CREATE TABLE public.page_views (storage integer, image text);",
      "",
    ].join("\n"));
  });

  it("removes the age entries of a pg_restore -l listing and keeps everything else", () => {
    const toc = [
      "; Archive created at 2026-10-30 03:00:00 UTC",
      "10; 2615 16384 SCHEMA - ag_catalog postgres",
      "3079; 3079 16385 EXTENSION - age ",
      "5100; 0 0 COMMENT - EXTENSION age ",
      "3080; 3079 16999 EXTENSION - vector ",
      "230; 1259 17001 TABLE public page_views onden",
    ].join("\n") + "\n";
    expect(strip(toc)).toBe([
      "; Archive created at 2026-10-30 03:00:00 UTC",
      "3080; 3079 16999 EXTENSION - vector ",
      "230; 1259 17001 TABLE public page_views onden",
    ].join("\n") + "\n");
  });
});

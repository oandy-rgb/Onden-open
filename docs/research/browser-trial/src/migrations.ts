// 遷移檔的來源與 PGlite 不支援的擴充處理。
// Node 版：讀 packages/backend/db/migrations/*.sql；瀏覽器版：建置時由 esbuild 把 SQL 內嵌成字串（build-browser.mjs 的 plugin）。
import { pgliteInstance } from "../pgShim.mjs";
// @ts-expect-error 由 build 注入
import * as sources from "virtual:migrations";
// @ts-expect-error 由 build 注入
import * as compat from "virtual:pgroonga-compat";

// 實驗用的最小改寫（與 docs/research/desktop-app 同一套）：PGlite 沒有 age / pgroonga / pg_stat_statements。
function strip(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS (age|pgroonga|pg_stat_statements)[^;]*;/gi, "")
    .replace(/CREATE INDEX[^;]*USING pgroonga[^;]*;/gi, "")
    .replace(/LOAD 'age';?/gi, "")
    .replace(/SET search_path[^;]*ag_catalog[^;]*;/gi, "");
}

export async function applyMigrations(): Promise<number> {
  const db = await pgliteInstance();
  await db.exec(`CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  if (!(await db.query("SELECT 1 FROM pg_proc WHERE proname = 'onden_match'")).rows.length) await db.exec((compat as { default: string }).default);
  let applied = 0;
  for (const [version, sql] of (sources as { default: [string, string][] }).default) {
    if (done.has(version)) continue;
    await db.exec("BEGIN");
    try {
      await db.exec(strip(sql));
      await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await db.exec("COMMIT");
    } catch (e) {
      await db.exec("ROLLBACK").catch(() => {});
      throw new Error(`migration ${version} failed: ${(e as Error).message}`);
    }
    applied++;
  }
  return applied;
}

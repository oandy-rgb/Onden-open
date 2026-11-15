// Restore drill: run the backend's own boot-time migrations (db.ts migrate())
// from a source tree against DATABASE_URL (the drill database).
//
//   DATABASE_URL=… tsx drillMigrate.ts <repo-root>
//
// The migration runner is imported from <repo-root>, not reimplemented: with
// `restore-drill.sh --commit <ref>` that is a checkout of <ref>. Production
// seeds no System actor at boot (nativeBypass off), so seedNativeActor is false.
// Failure output names only the migration and the PostgreSQL error code/table/
// constraint — never the message or detail, which can quote row values.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertDrillDatabase } from "./drillInvariants.js";

assertDrillDatabase(process.env.DATABASE_URL);
const root = process.argv[2];
if (!root) { console.error("用法：drillMigrate.ts <repo-root>"); process.exit(2); }
const backend = join(root, "packages/backend");
const db = await import(pathToFileURL(join(backend, "src/db.ts")).href) as typeof import("../src/db.js");

const versions = () => readdirSync(join(backend, "db/migrations")).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
const appliedNow = async () => {
  const { rows } = await db.pool.query<{ version: string }>(`SELECT version FROM schema_migrations`).catch(() => ({ rows: [] }));
  return new Set(rows.map((r) => r.version));
};

let code = 0;
try {
  await db.migrate({ seedNativeActor: false });
  console.log("migration 完成");
} catch (e) {
  const err = e as { code?: string; table?: string; constraint?: string };
  const done = await appliedNow();
  const failed = versions().find((v) => !done.has(v)) ?? "未知";
  console.error(`migration 失敗：${failed}（PostgreSQL 代碼 ${err.code ?? "無"}，表 ${err.table ?? "無"}，約束 ${err.constraint ?? "無"}）`);
  code = 1;
} finally {
  await db.pool.end();
}
process.exit(code);

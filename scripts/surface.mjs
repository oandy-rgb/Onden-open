#!/usr/bin/env node
// 降「入口寬度」基準（scripts/surface-baseline.json）：以寫入模式跑兩個守門測試。任何數字上升就拒絕。
//   node scripts/surface.mjs          降基準
//   node scripts/surface.mjs --init   另外允許建立還沒有基準的名稱
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { root } from "./allowlistLib.mjs";

const mode = process.argv.includes("--init") ? "init" : "lower";
for (const [pkg, file] of [["packages/markdown", "src/test/guards/surface.guard.test.ts"], ["packages/frontend", "src/test/guards/appStoreSurface.guard.test.ts"]]) {
  const run = spawnSync("npx", ["--no-install", "vitest", "run", file], { cwd: join(root, pkg), stdio: "inherit", env: { ...process.env, SURFACE_WRITE: mode } });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
console.log(`surface baseline 已更新（${mode}）`);

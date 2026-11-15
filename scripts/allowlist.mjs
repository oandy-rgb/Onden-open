#!/usr/bin/env node
// 降允許清單基準：以寫入模式跑各套件的 allowlist 守門測試，每條規則把目前次數寫回
// scripts/allowlist-baseline.json。任何次數上升就拒絕（基準只准往下）。
//   node scripts/allowlist.mjs            降基準
//   node scripts/allowlist.mjs --init     另外允許建立還沒有基準的規則（新增規則時用一次）
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { root } from "./allowlistLib.mjs";

const mode = process.argv.includes("--init") ? "init" : "lower";
const suites = [
  ["packages/frontend", "src/test/guards/allowlist"],
  ["packages/backend", "src/test/guards/allowlist"],
];
for (const [pkg, filter] of suites) {
  const run = spawnSync("npx", ["--no-install", "vitest", "run", "--no-file-parallelism", "--sequence.shuffle=false", filter], {
    cwd: join(root, pkg),
    stdio: "inherit",
    env: { ...process.env, ALLOWLIST_WRITE: mode },
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
console.log(`allowlist baseline 已更新（${mode}）`);

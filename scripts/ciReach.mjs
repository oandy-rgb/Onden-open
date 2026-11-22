// npm run ci:reach — every test file and check script that no CI job runs (scripts/ciReachLib.mjs). Exit 1 when any.
//   node scripts/ciReach.mjs [--reached]   (--reached also prints what CI does run)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gaps, report } from "./ciReachLib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = gaps(root);
if (process.argv.includes("--reached")) {
  const r = result.reached;
  console.log(["npm scripts:", ...[...r.scripts].sort(), "vitest configs:", ...[...r.vitest].sort(), "playwright configs:", ...[...r.playwright].sort(), "files:", ...[...r.files].sort()].join("\n  "));
}
const text = report(result);
console.log(text || "ci:reach 通過：每個測試檔與檢查指令都有 CI 工作在跑（或寫明了刻意不跑的理由）。");
process.exit(text ? 1 : 0);

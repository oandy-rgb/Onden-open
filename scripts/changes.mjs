#!/usr/bin/env node
// 防漏寫更新說明：比對 origin/main...HEAD，動到 packages/frontend/src 或 packages/site/src 的
// 非測試檔、卻沒有新增 changes/*.md，就提醒並以 1 結束。判斷在 scripts/changesLib.mjs。
//   npm run changes:check                       預設比對 origin/main
//   npm run changes:check -- --base <ref>       換比對的基準
//   npm run changes:check -- --skip             PR 說明含「不需要更新說明」時略過
//   CHANGES_SKIP=1 或 PR_BODY="…不需要更新說明…" 也可（不必呼叫 GitHub）
import { checkChanges, diffEntries, SKIP_PHRASE, skipRequested } from './changesLib.mjs';

const argv = process.argv.slice(2);
const baseAt = argv.indexOf('--base');
const base = baseAt >= 0 ? argv[baseAt + 1] : 'origin/main';

if (skipRequested(argv, process.env)) {
  console.log(`changes:check 略過（${SKIP_PHRASE}）。`);
  process.exit(0);
}

let entries;
try {
  entries = diffEntries(base);
} catch (e) {
  console.error(`無法比對 ${base}...HEAD：${e.message}`);
  process.exit(2);
}

const result = checkChanges(entries);
if (result.ok) {
  console.log(result.touched.length === 0
    ? 'changes:check 通過：沒有動到使用者看得到的程式。'
    : `changes:check 通過：已新增 ${result.added.join('、')}`);
  process.exit(0);
}

console.error(`動到了使用者可能看得到的程式（${result.touched.length} 個檔案），但沒有新增 changes/*.md：`);
for (const path of result.touched.slice(0, 10)) console.error(`  ${path}`);
if (result.touched.length > 10) console.error(`  …還有 ${result.touched.length - 10} 個`);
console.error('\n請在 changes/ 加一個檔案（寫法見 changes/README.md，例如 changes/2026-10-29-短描述.md）。');
console.error(`確實使用者看不出差別（只改內部、測試）時，在 PR 說明寫「${SKIP_PHRASE}」，再用 --skip 或 CHANGES_SKIP=1 略過。`);
process.exit(1);

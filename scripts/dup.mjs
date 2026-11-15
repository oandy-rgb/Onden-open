#!/usr/bin/env node
// 逐字複製偵測（jscpd，設定見 .jscpd.json）；邏輯在 scripts/dupLib.mjs，守門測試共用。
//   node scripts/dup.mjs          產生報告（node_modules/.cache/jscpd/）並印出摘要與最大的 10 組
//   node scripts/dup.mjs --check  與 scripts/dup-baseline.json 比較；只准減、不准增
//   node scripts/dup.mjs --write-baseline  把目前數量寫回 baseline（降低時用）
import { compareDuplicates, scanDuplicates, writeDupBaseline } from './dupLib.mjs';

const mode = process.argv[2];
let scan;
try {
  scan = scanDuplicates();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const { current, duplicates } = scan;

if (mode === '--write-baseline') {
  writeDupBaseline(current);
  console.log(`baseline 已更新：${current.clones} 組、${current.duplicatedLines} 行`);
  process.exit(0);
}

console.log(`目前重複：${current.clones} 組、${current.duplicatedLines} 行`);

if (mode !== '--check') {
  console.log('最大的 10 組：');
  for (const d of duplicates.slice(0, 10)) console.log(`  ${d.lines} 行  ${d.where}`);
  process.exit(0);
}

const result = compareDuplicates(scan);
for (const line of result.errors) console.error(line);
for (const line of result.notes) console.log(line);
if (!result.ok) process.exit(1);
console.log('dup:check 通過');

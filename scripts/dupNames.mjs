#!/usr/bin/env node
// 同名匯出檢查（jscpd 抓不到的重複）；邏輯在 scripts/dupLib.mjs，守門測試共用。
//   node scripts/dupNames.mjs                 列出目前所有同名匯出
//   node scripts/dupNames.mjs --check         與 scripts/dup-names-baseline.json 比較；只准減、不准增
//   node scripts/dupNames.mjs --write-baseline  把目前清單寫回 baseline（降低時用）
import { compareDuplicateNames, scanDuplicateNames, writeNamesBaseline } from './dupLib.mjs';

const mode = process.argv[2];
const current = scanDuplicateNames();

if (mode === '--write-baseline') {
  writeNamesBaseline(current);
  console.log(`baseline 已更新：${Object.keys(current.names).length} 個同名匯出；前後端同名型別只減不增`);
  process.exit(0);
}
console.log(`目前同名匯出：${Object.keys(current.names).length} 個名稱；前後端同名型別：${Object.keys(current.types).length} 個名稱`);
if (mode !== '--check') {
  for (const [name, files] of Object.entries(current.names)) console.log(`  ${name}：${files.join('、')}`);
  for (const [name, files] of Object.entries(current.types)) console.log(`  [型別] ${name}：${files.join('、')}`);
  process.exit(0);
}
const result = compareDuplicateNames(current);
for (const line of result.errors) console.error(line);
for (const line of result.notes) console.log(line);
if (!result.ok) process.exit(1);
console.log('dup:names 通過');

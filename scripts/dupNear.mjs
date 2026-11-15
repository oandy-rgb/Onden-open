#!/usr/bin/env node
// 近似重複（改名／改註解後的函式複本）偵測；邏輯在 scripts/dupNearLib.mjs，守門測試共用。
//   node scripts/dupNear.mjs                  列出目前所有近似重複的函式對（相似度大的在前）
//   node scripts/dupNear.mjs --check          與 scripts/dup-near-baseline.json 比較；只准減、不准增
//   node scripts/dupNear.mjs --write-baseline 把目前清單寫回 baseline（只准降低；第一次建立用 --init）
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './dupLib.mjs';
import { compareNearDuplicates, describePair, scanNearDuplicates, writeNearBaseline } from './dupNearLib.mjs';

const mode = process.argv[2];
const scan = scanNearDuplicates();
const count = Object.keys(scan.current).length;

if (mode === '--write-baseline' || mode === '--init') {
  const exists = existsSync(join(root, 'scripts', 'dup-near-baseline.json'));
  if (mode === '--write-baseline' && exists) {
    const result = compareNearDuplicates(scan);
    if (!result.ok) {
      for (const line of result.errors) console.error(line);
      console.error('baseline 只准降低，不寫入。');
      process.exit(1);
    }
  }
  writeNearBaseline(scan.current);
  console.log(`baseline 已更新：${count} 組近似重複`);
  process.exit(0);
}
console.log(`目前近似重複：${count} 組`);
if (mode !== '--check') {
  for (const p of scan.pairs) console.log(`  ${describePair(p)}`);
  process.exit(0);
}
const result = compareNearDuplicates(scan);
for (const line of result.errors) console.error(line);
for (const line of result.notes) console.log(line);
if (!result.ok) process.exit(1);
console.log('dup:near:check 通過');

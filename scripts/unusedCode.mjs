#!/usr/bin/env node
// 無人使用的程式碼檢查；邏輯在 scripts/unusedCodeLib.mjs。
//   node scripts/unusedCode.mjs              列出目前所有死碼（不比對基準）
//   node scripts/unusedCode.mjs --check      與 scripts/unused-code-baseline.json 比較（guard lane 跑這個）
//   node scripts/unusedCode.mjs --shrink     把基準裡已清掉的條目刪掉（只減不增）
//   node scripts/unusedCode.mjs --seed       把目前所有死碼寫進 leftover（只在建立基準時用）
import { compareUnused, scanUnused, seedBaseline, shrinkBaseline, readBaseline, writeBaseline } from "./unusedCodeLib.mjs";

const mode = process.argv[2];
const started = Date.now();
const current = scanUnused();
const n = (o) => Object.keys(o).length;

if (mode === "--seed") {
  writeBaseline(seedBaseline(current));
  console.log(`基準已建立：${n(current.files)} 個檔案、${n(current.exports)} 個匯出（含 intentional）。`);
} else if (mode === "--shrink") {
  writeBaseline(shrinkBaseline(current));
  console.log("基準已縮到目前的死碼。");
} else if (mode === "--check") {
  const result = compareUnused(current, readBaseline());
  for (const line of result.errors) console.error(line);
  if (!result.ok) {
    console.error(`unused:check 失敗（${result.errors.length} 項）。`);
    process.exit(1);
  }
  console.log(`unused:check 通過（${((Date.now() - started) / 1000).toFixed(1)}s；基準內 ${n(current.files)} 個檔案、${n(current.exports)} 個匯出）`);
} else {
  for (const k of Object.keys(current.files)) console.log(`[檔案] ${k}`);
  for (const k of Object.keys(current.exports)) console.log(`[匯出] ${k}`);
  console.log(`共 ${n(current.files)} 個檔案、${n(current.exports)} 個匯出`);
}

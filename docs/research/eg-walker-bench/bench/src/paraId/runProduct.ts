// 產品的 mergeBody（行級為主、衝突時才補救、兩邊搬同一段判衝突）對現行行級合併 threeWayMergeBody 的前後對照。
//   (b) 14 種情境：  npx tsx src/paraId/runProduct.ts b 300
//   (c) 既有測試錄下的輸入：  npx tsx src/paraId/runProduct.ts c <錄下來的 jsonl>...
import { readFileSync } from "node:fs";
import { threeWayMergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { mergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMergeMoves.js";
import { mergeLossProblems } from "../../../../../../packages/backend/src/services/eventLog/bodyMergeLoss.js";
import { KIND_NAMES, genScenario } from "./scenarios.js";
import { show } from "./evaluate.js";

type Row = { before: ReturnType<typeof threeWayMergeBody>; after: ReturnType<typeof mergeBody>; wrongBefore: boolean; wrongAfter: boolean };
const wrong = (r: { clean: boolean; merged: string }, c: { base: string; incoming: string; current: string }, expected?: string | null) =>
  r.clean && (mergeLossProblems(c.base, c.incoming, c.current, r.merged).length > 0 || (expected != null && r.merged !== expected));
const both = (c: { base: string; incoming: string; current: string }, expected?: string | null): Row => {
  const before = threeWayMergeBody(c.base, c.incoming, c.current), after = mergeBody(c.base, c.incoming, c.current);
  return { before, after, wrongBefore: wrong(before, c, expected), wrongAfter: wrong(after, c, expected) };
};

const [mode, ...rest] = process.argv.slice(2);
if (mode === "b") {
  const N = Number(rest[0] ?? 300);
  console.log("| 情境 | 現行判衝突 | 新版判衝突 | 理想達成：現行 | 理想達成：新版 | 錯誤結果：現行 | 錯誤結果：新版 |\n|---|---|---|---|---|---|---|");
  const tot = { cc: 0, ac: 0, ci: 0, ai: 0, cw: 0, aw: 0 };
  for (const kind of KIND_NAMES) {
    const t = { cc: 0, ac: 0, ci: 0, ai: 0, cw: 0, aw: 0 };
    for (let seed = 1; seed <= N; seed++) {
      const s = genScenario(kind, seed);
      const r = both(s, s.expected);
      const ok = (m: { clean: boolean; merged: string }) => s.expect === "conflict" ? !m.clean : m.clean && (s.expected === null ? !wrong(m, s) : m.merged === s.expected);
      t.cc += +!r.before.clean; t.ac += +!r.after.clean; t.ci += +ok(r.before); t.ai += +ok(r.after); t.cw += +r.wrongBefore; t.aw += +r.wrongAfter;
    }
    for (const k of Object.keys(t) as Array<keyof typeof t>) tot[k] += t[k];
    console.log(`| ${kind} | ${t.cc} | ${t.ac} | ${t.ci} | ${t.ai} | ${t.cw} | ${t.aw} |`);
  }
  console.log(`| **合計（${N * KIND_NAMES.length}）** | ${tot.cc} | ${tot.ac} | ${tot.ci} | ${tot.ai} | ${tot.cw} | ${tot.aw} |`);
} else if (mode === "c") {
  const seen = new Set<string>();
  const c = { n: 0, before: 0, after: 0, newlyClean: 0, newlyConflict: 0, newlyConflictWasWrong: 0, wrongBefore: 0, wrongAfter: 0, cleanChanged: 0 };
  const newly: string[] = [];
  let msBefore = 0, msAfter = 0;
  for (const f of rest) for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const i = JSON.parse(line) as { file: string; base: string; incoming: string; current: string };
    const key = JSON.stringify([i.base, i.incoming, i.current]);
    if (seen.has(key)) continue;
    seen.add(key);
    c.n++;
    let t = performance.now(); threeWayMergeBody(i.base, i.incoming, i.current); msBefore += performance.now() - t;
    t = performance.now(); mergeBody(i.base, i.incoming, i.current); msAfter += performance.now() - t;
    const r = both(i);
    c.before += +!r.before.clean; c.after += +!r.after.clean; c.wrongBefore += +r.wrongBefore; c.wrongAfter += +r.wrongAfter;
    if (!r.before.clean && r.after.clean) c.newlyClean++;
    if (r.before.clean && r.after.clean && r.before.merged !== r.after.merged) c.cleanChanged++;
    if (r.before.clean && !r.after.clean) {
      c.newlyConflict++; c.newlyConflictWasWrong += +r.wrongBefore;
      newly.push(`${i.file}\n  base:     ${show(i.base, 200)}\n  incoming: ${show(i.incoming, 200)}\n  current:  ${show(i.current, 200)}\n  現行乾淨結果：${show(r.before.merged, 200)}\n  現行結果有行數問題：${r.wrongBefore}`);
    }
  }
  console.log(JSON.stringify(c), `總時間 現行 ${msBefore.toFixed(1)}ms 新版 ${msAfter.toFixed(1)}ms`);
  console.log(newly.join("\n---\n"));
}

// 合併規則 2 與 3 的前後對照（產品的 mergeBody(…, rule)），用兩個寫作者的隨機修改
// （packages/backend/src/test/helpers/bodyMergeWriters.ts，與性質測試同一個產生器）。
//   npx tsx src/paraId/runRules.ts <筆數> [種子]
// 印出：判成衝突的比例、四個性質（沒人寫過的行、字不見、交換後不一致、同一行出現兩次）各違反幾筆，
// 以及兩個常見情況（兩人改不同段落、同一點各加一段）判成衝突的比例。
import fc from "fast-check";
import { mergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMergeMoves.js";
import {
  baseDoc, doubledLines, renderParagraphs, tagsIn, unwrittenLines, write, writerEdits, type Paragraphs,
} from "../../../../../../packages/backend/src/test/helpers/bodyMergeWriters.js";

const N = Number(process.argv[2] ?? 20000);
const SEED = Number(process.argv[3] ?? 20261119);
type Case = { base: string; a: string; b: string };

const random = fc.sample(
  fc.tuple(baseDoc, writerEdits, writerEdits).map(([d, x, y]): Case => ({ base: renderParagraphs(d), a: renderParagraphs(write(d, x, "甲")), b: renderParagraphs(write(d, y, "乙")) })),
  { seed: SEED, numRuns: N },
);
// 兩人改不同段落：各自在不同段落裡打字或加一行。
const differentParagraphs = fc.sample(
  fc.tuple(baseDoc.filter((d) => d.length >= 2), fc.nat(99), fc.nat(99), fc.nat(99), fc.nat(99), fc.boolean(), fc.boolean()).map(([d, p, q, x, y, lineA, lineB]): Case => {
    const i = p % d.length, j = (i + 1 + (q % (d.length - 1))) % d.length;
    const one = (k: number, at: number, line: boolean, tag: string): Paragraphs => write(d, [line ? { op: "addLine", p: k, at } : { op: "type", p: k, l: at, at, text: "很" }], tag);
    return { base: renderParagraphs(d), a: renderParagraphs(one(i, x, lineA, "甲")), b: renderParagraphs(one(j, y, lineB, "乙")) };
  }),
  { seed: SEED + 1, numRuns: N },
);
// 同一點各加一段。
const samePointParagraphs = fc.sample(
  fc.tuple(baseDoc, fc.nat(99), fc.integer({ min: 1, max: 2 }), fc.integer({ min: 1, max: 2 })).map(([d, at, la, lb]): Case => ({
    base: renderParagraphs(d), a: renderParagraphs(write(d, [{ op: "addPara", at, lines: la }], "甲")), b: renderParagraphs(write(d, [{ op: "addPara", at, lines: lb }], "乙")),
  })),
  { seed: SEED + 2, numRuns: N },
);

function measure(cases: Case[], rule: 2 | 3) {
  const t = { conflict: 0, unwritten: 0, lost: 0, asymmetric: 0, doubled: 0 };
  for (const { base, a, b } of cases) {
    const ab = mergeBody(base, a, b, rule), ba = mergeBody(base, b, a, rule);
    t.conflict += +!ab.clean;
    t.unwritten += +(unwrittenLines(base, a, b, ab.merged).length + unwrittenLines(base, b, a, ba.merged).length > 0);
    const kept = (r: typeof ab) => r.merged + r.conflicts.map((c) => c.incoming + c.current).join("");
    t.lost += +[...tagsIn(a, "甲"), ...tagsIn(b, "乙")].some((tag) => !kept(ab).includes(tag) || !kept(ba).includes(tag));
    t.asymmetric += +(ab.clean !== ba.clean || (ab.clean && ab.merged !== ba.merged));
    t.doubled += +(doubledLines(base, a, b, ab.merged).length + doubledLines(base, b, a, ba.merged).length > 0);
  }
  return t;
}

const pct = (n: number) => `${n}（${((100 * n) / N).toFixed(2)}%）`;
/** 規則 2 → 3 的改變：原本乾淨又沒有問題、現在判衝突的（真正多出來的衝突）；原本乾淨但有問題、現在判衝突的；原本衝突、現在乾淨的。 */
function changes(cases: Case[]) {
  const t = { goodToConflict: 0, badToConflict: 0, conflictToClean: 0, cleanTextChanged: 0, cleanTextChangedWasBad: 0 };
  const examples: string[] = [];
  for (const { base, a, b } of cases) {
    const r2 = mergeBody(base, a, b, 2), r2s = mergeBody(base, b, a, 2), r3 = mergeBody(base, a, b, 3);
    const bad = unwrittenLines(base, a, b, r2.merged).length + doubledLines(base, a, b, r2.merged).length > 0 || r2s.clean !== r2.clean || (r2.clean && r2s.merged !== r2.merged);
    if (r2.clean && !r3.clean) { if (bad) t.badToConflict++; else { t.goodToConflict++; if (examples.length < 3) examples.push(JSON.stringify({ base, a, b, rule2: r2.merged })); } }
    if (!r2.clean && r3.clean) t.conflictToClean++;
    if (r2.clean && r3.clean && r2.merged !== r3.merged) { t.cleanTextChanged++; t.cleanTextChangedWasBad += +bad; if (!bad && examples.length < 5) examples.push(`文字不同 ${JSON.stringify({ base, a, b, rule2: r2.merged, rule3: r3.merged })}`); }
  }
  return { ...t, examples };
}

console.log(`筆數 ${N}，種子 ${SEED}\n`);
console.log("| 資料 | 規則 | 判衝突 | 沒人寫過的行 | 字不見 | 交換後不一致 | 同一行兩次 |\n|---|---|---|---|---|---|---|");
for (const [name, cases] of [["隨機兩人修改", random], ["兩人改不同段落", differentParagraphs], ["同一點各加一段", samePointParagraphs]] as const) {
  for (const rule of [2, 3] as const) {
    const t = measure(cases, rule);
    console.log(`| ${name} | ${rule} | ${pct(t.conflict)} | ${pct(t.unwritten)} | ${pct(t.lost)} | ${pct(t.asymmetric)} | ${pct(t.doubled)} |`);
  }
}

const c = changes(random);
console.log(`\n隨機兩人修改，規則 2 → 3：原本乾淨且沒問題→衝突 ${c.goodToConflict}；原本乾淨但有問題（沒人寫過的行／兩次／交換不一致）→衝突 ${c.badToConflict}；衝突→乾淨 ${c.conflictToClean}；乾淨但文字不同 ${c.cleanTextChanged}（其中規則 2 的結果本來就有問題 ${c.cleanTextChangedWasBad}）`);
for (const e of c.examples) console.log("  例：", e);

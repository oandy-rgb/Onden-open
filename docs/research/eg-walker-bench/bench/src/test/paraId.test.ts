// 認段落身分的合併原型（src/paraId/）的基本保證。node --test（tsx）。
import test from "node:test";
import assert from "node:assert/strict";
import { paraMergeBody } from "../paraId/paraMerge.js";
import { mergeUnits } from "../../../../../../packages/backend/src/services/eventLog/bodyMergeMoves.js";
import { EXAMPLES } from "../paraId/examples.js";
import { threeWayMergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMerge.js";

const ex = (id: string) => EXAMPLES.find((e) => e.id === id)!;

test("切單位：沒有任何改動時，逐單位合併原樣還原原文（splitUnits 已是產品內部函式，這裡經 mergeUnits 驗）", () => {
  for (const text of ["a\n\nb\n", "- x\n- y\n\npara\nline2\n", "```ts\ncode\n\nmore\n```\n\nafter", "", "\n\nlead\n", "# h\ntext\r\n\r\nnext\r\n"]) {
    const r = mergeUnits(text, text, text);
    assert.ok(r && "merged" in r);
    assert.equal(r.merged, text);
  }
});

test("搬段落＋對方改它：原型合併乾淨，現行合併判衝突", () => {
  const e = ex("X1");
  assert.equal(threeWayMergeBody(e.base, e.incoming, e.current).clean, false);
  const r = paraMergeBody(e.base, e.incoming, e.current);
  assert.equal(r.clean, true);
  assert.ok(r.merged.endsWith("第二段：同步功能要在週四前做完，測試都通過。\n"));
});

test("兩邊把同一段搬到不同的地方：原型判衝突", () => {
  const e = ex("X4");
  const r = paraMergeBody(e.base, e.incoming, e.current);
  assert.equal(r.clean, false);
  assert.deepEqual(r.kinds, ["move-move"]);
});

test("同一段不同句子各改各的：仍是衝突（認段落解不了）", () => {
  const e = ex("X5");
  assert.equal(paraMergeBody(e.base, e.incoming, e.current).clean, false);
});

test("兩邊各自把同一段改得面目全非：衝突，不默默留兩份", () => {
  const r = paraMergeBody("a\nb\nc\nd\n", "a\nB1\nc\nd\n", "a\nB2\nc\nd\n");
  assert.equal(r.clean, false);
});

test("一邊沒動：回傳另一邊", () => {
  assert.equal(paraMergeBody("x\n", "x\n", "y\n").merged, "y\n");
  assert.equal(paraMergeBody("x\n", "y\n", "x\n").merged, "y\n");
});

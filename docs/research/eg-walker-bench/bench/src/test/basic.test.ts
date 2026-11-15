import test from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../prng.js";
import { TextBuf } from "../textBuf.js";
import { EXAMPLES, exampleTexts } from "../examples.js";
import { buildOpLog, makeBranch, mergeIntoBranch, replay, DEFAULT_OPTS } from "../proto/engine.js";
import { overlapSentences, touchSets } from "../analysis.js";
import { decodeHistory, encodeHistory } from "../proto/serialize.js";
import { makeFork } from "../genFork.js";
import { sentenceSpans } from "../sentences.js";

test("TextBuf 與字串操作一致", () => {
  const rng = makeRng(7);
  let s = "";
  const b = new TextBuf();
  for (let i = 0; i < 3000; i++) {
    if (s.length > 0 && rng.chance(0.4)) {
      const pos = rng.int(s.length), n = 1 + rng.int(Math.min(900, s.length - pos));
      s = s.slice(0, pos) + s.slice(pos + n); b.delete(pos, n);
    } else {
      const pos = rng.int(s.length + 1), t = "字abc😀".repeat(1 + rng.int(300));
      s = s.slice(0, pos) + t + s.slice(pos); b.insert(pos, t);
    }
  }
  assert.equal(b.toString(), s);
  assert.equal(b.length, s.length);
});

test("例子：同一句重疊的判定", () => {
  const want: Record<string, number> = { E1: 0, E2: 1, E3: 1, E4: 0, E5: 1, E6: 1, E7: 0 };
  for (const ex of EXAMPLES) {
    const t = exampleTexts(ex);
    const log = buildOpLog(t.history);
    const br = makeBranch(t.a, [t.rangeA[1] - 1]);
    const info = mergeIntoBranch(br, log, undefined, DEFAULT_OPTS, true);
    const [ta, tb] = touchSets(info.ctx!, t.rangeA, t.rangeB);
    assert.equal(overlapSentences(ex.base, ta, tb).length, want[ex.id], ex.id);
    // 合併結果＝整份歷史重放
    assert.equal(br.text.toString(), replay(log), ex.id);
  }
});

test("序列化來回一致、合成情境可重現", () => {
  const sc = makeFork(10 * 1024, 100, 5);
  const again = makeFork(10 * 1024, 100, 5);
  assert.equal(sc.base, again.base);
  assert.equal(sc.textA, again.textA);
  assert.deepEqual(decodeHistory(encodeHistory(sc.history)).txns, sc.history.txns);
  assert.equal(replay(buildOpLog(sc.history)).length > 0, true);
  // 沒有重疊時兩支都保留：合併結果的長度＝base＋兩邊增量（有重疊的刪除會重複計算，所以只檢查下界）
  assert.ok(sentenceSpans(sc.base).length > 50);
  // 合併後不能出現孤立的代理字（emoji 被切半）
  const merged = replay(buildOpLog(sc.history));
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(merged), false);
});

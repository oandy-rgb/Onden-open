// 同一點同時插入的先後規則（推薦：FugueMax 右原點＋ (來源節點 id, 序號) 升冪，小的在左）的測試。
// 執行：npm run test:tiebreak（trace 資料要先 ./scripts/fetch-data.sh，沒有就跳過那幾項並說明）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadTrace } from "../traces.js";
import { BROKEN, RULES, buildOpLog, replay, withRule } from "./variantEngine.js";
import { buildRealSeqLog, loadRaw, type SeqTxn } from "./realSeq.js";
import { convergence, interleaving, type Typing } from "./props.js";

const RECOMMENDED = RULES.maxAsc;
const haveData = existsSync(join(DATA_DIR, "git-makefile-raw.json"));
const N = Number(process.env.TIEBREAK_N ?? 150);

test("最小重現：同一個 agent 在兩條並行分支，先後取決於真實 seq；把 seq 照到達順序重編就會顛倒", () => {
  const txn = (seqStart: number, ch: string, start: number): SeqTxn => ({ agent: "A", seqStart, start, parents: [], ops: [[0, 0, ch]] });
  // x 的真實序號 5、y 的真實序號 0；x 先到。
  const txns = [txn(5, "x", 0), txn(0, "y", 1)];
  assert.equal(withRule(RECOMMENDED, () => replay(buildRealSeqLog(txns))), "yx", "(A,0) 比 (A,5) 小，在左");
  assert.equal(withRule(RECOMMENDED, () => replay(buildOpLog({ txns }))), "xy", "原轉接層：到達順序重編成 0、1，結果顛倒");
});

test("最小重現：兩個節點同時在同一點插入，節點 id 小的在左，與到達順序無關", () => {
  const a: SeqTxn = { agent: "n1", seqStart: 0, start: 0, parents: [], ops: [[0, 0, "AB"]] };
  const b: SeqTxn = { agent: "n2", seqStart: 0, start: 2, parents: [], ops: [[0, 0, "CD"]] };
  assert.equal(withRule(RECOMMENDED, () => replay(buildRealSeqLog([a, b]))), "ABCD");
  // 換到達順序（LV 不同、來源標記相同）
  assert.equal(withRule(RECOMMENDED, () => replay(buildRealSeqLog([{ ...b, start: 0 }, { ...a, start: 2 }]))), "ABCD");
});

for (const [file, label] of [["ff-raw.json", "friendsforever"], ["git-makefile-raw.json", "git-makefile"], ["node_nodecc-raw.json", "node_nodecc"]] as const) {
  test(`trace ${label}：推薦規則＋真實 (agent, seq) 重放＝預期文字`, { skip: !haveData && "沒有 data/（先跑 scripts/fetch-data.sh）" }, () => {
    const r = loadRaw(file);
    assert.equal(withRule(RECOMMENDED, () => replay(buildRealSeqLog(r.txns))), r.endContent);
  });
}
for (const id of ["clownschool", "automerge-paper", "seph-blog1"]) {
  test(`trace ${id}：推薦規則重放＝預期文字`, { skip: !haveData && "沒有 data/（先跑 scripts/fetch-data.sh）" }, () => {
    const tr = loadTrace(id);
    assert.equal(withRule(RECOMMENDED, () => replay(buildOpLog(tr.history))), tr.history.endContent);
  });
}

test("git-makefile：反過來（大的在左）重放不出預期文字——位置只在產生它的規則下有意義", { skip: !haveData && "沒有 data/" }, () => {
  const r = loadRaw("git-makefile-raw.json");
  let out: string | null;
  try { out = withRule(RULES.maxDesc, () => replay(buildRealSeqLog(r.txns))); } catch { out = null; }
  assert.notEqual(out, r.endContent);
});

for (const [name, rule] of [["推薦（FugueMax＋升冪）", RULES.maxAsc], ["Fugue 右父＋升冪（原型現況）", RULES.fugueAsc]] as const) {
  test(`性質：任意送達順序收斂（${name}，${N} 個種子）`, () => {
    for (let seed = 1; seed <= N; seed++) { const r = convergence(seed, rule); assert.ok(r.ok, `seed=${seed} ${r.why}`); }
  });
  const kinds: Typing[][] = [["forward", "forward"], ["backward", "backward"], ["forward", "backward"], ["inside", "inside"], ["block", "forward", "backward"], ["forward", "forward", "forward"], ["inside", "backward", "forward"]];
  test(`性質：同一點兩段以上的多字插入不交錯（${name}）`, () => {
    for (const ty of kinds) for (let seed = 1; seed <= N; seed++) {
      const r = interleaving(seed, rule, ty);
      assert.ok(r.ok, `${ty.join("+")} seed=${seed} ${r.text}`);
    }
  });
}

test("測試有檢出力：故意寫壞的規則（看到達順序、不跳過別人子樹）會被抓到", () => {
  for (const [name, rule] of Object.entries(BROKEN)) {
    let failed = 0;
    for (let seed = 1; seed <= 60; seed++) if (!convergence(seed, rule).ok) failed++;
    for (let seed = 1; seed <= 60; seed++) if (!interleaving(seed, rule, ["forward", "backward"]).ok) failed++;
    assert.ok(failed > 0, `${name} 應該至少有一個失敗`);
  }
});

// 原型與參考實作交叉比對：隨機多人並行歷史，三種路徑結果必須一致。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../prng.js";
import { ref, cg, refLogToHistory } from "../refAdapter.js";
import { buildOpLog, replay, mergeIntoBranch, makeBranch, DEFAULT_OPTS, type EngineOpts } from "../proto/engine.js";

const N = Number(process.env.FUZZ_N ?? 150);
const ALPHABET = "abcdefghij\n 的字";

function randomHistory(seed: number, agents: number, rounds: number) {
  const rng = makeRng(seed);
  const logs = Array.from({ length: agents }, () => ref.createOpLog<string>());
  const branches = logs.map(() => ref.createEmptyBranch() as ref.Branch<string>);
  const names = Array.from({ length: agents }, (_, i) => `a${i}`);
  for (let r = 0; r < rounds; r++) {
    const a = rng.int(agents);
    const log = logs[a]!, br = branches[a]!;
    const n = rng.int(4);
    for (let k = 0; k <= n; k++) {
      const len = br.snapshot.length;
      if (len > 0 && rng.chance(0.4)) {
        const pos = rng.int(len);
        const del = 1 + rng.int(Math.min(3, len - pos));
        ref.localDelete(log, names[a]!, pos, del);
        br.snapshot.splice(pos, del);
      } else {
        const pos = rng.int(len + 1);
        const s = Array.from({ length: 1 + rng.int(4) }, () => rng.pick([...ALPHABET]));
        ref.localInsert(log, names[a]!, pos, ...s);
        br.snapshot.splice(pos, 0, ...s);
      }
      br.version = log.cg.heads.slice();
    }
    if (rng.chance(0.5)) {
      const b = rng.int(agents);
      if (b !== a) {
        ref.mergeOplogInto(logs[b]!, log);
        ref.mergeChangesIntoBranch(branches[b]!, logs[b]!);
      }
    }
  }
  // 全部同步
  for (let i = 0; i < agents; i++) for (let j = 0; j < agents; j++) if (i !== j) ref.mergeOplogInto(logs[i]!, logs[j]!);
  for (let i = 0; i < agents; i++) ref.mergeChangesIntoBranch(branches[i]!, logs[i]!);
  return { log: logs[0]!, text: branches[0]!.snapshot.join(""), branches, logs };
}

const VARIANTS: Array<[string, EngineOpts]> = [
  ["預設", DEFAULT_OPTS],
  ["不跳線性", { ...DEFAULT_OPTS, skipLinear: false }],
  ["單一陣列", { ...DEFAULT_OPTS, chunkMax: Infinity }],
  ["小 chunk", { ...DEFAULT_OPTS, chunkMax: 3 }],
  ["不合 run", { ...DEFAULT_OPTS, rle: false }],
];

test("replay 與參考實作一致（隨機並行歷史）", () => {
  let concurrentSegs = 0;
  for (let seed = 1; seed <= N; seed++) {
    const { log, text } = randomHistory(seed, 2 + (seed % 3), 6 + (seed % 20));
    assert.equal(ref.checkoutSimpleString(log), text, `參考實作自洽 seed=${seed}`);
    const h = refLogToHistory(log);
    for (const [name, o] of VARIANTS) {
      const pl = buildOpLog(h, o.rle);
      const stats = { segmentsLinear: 0, segmentsConcurrent: 0, opsLinear: 0, opsConcurrent: 0 };
      assert.equal(replay(pl, o, stats), text, `${name} seed=${seed}`);
      if (name === "預設") concurrentSegs += stats.segmentsConcurrent;
    }
  }
  assert.ok(concurrentSegs > 20, "要有足夠的並行區段才算數");
});

test("mergeIntoBranch 與參考實作一致（從舊版本分頭合併）", () => {
  let crdt = 0;
  for (let seed = 1; seed <= N; seed++) {
    const { logs, branches } = randomHistory(1000 + seed, 3, 10 + (seed % 20));
    // 取一個落後的分支：用最少操作的 agent 的 oplog 當舊狀態，把全部歷史（logs[0]）合進去
    const full = logs[0]!;
    const h = refLogToHistory(full);
    const pl = buildOpLog(h);
    for (let a = 1; a < 3; a++) {
      // 舊狀態＝只有 agent a 自己 oplog 時的 branch：重建
      const own = ref.createOpLog<string>();
      // 把 a 的 oplog 在合併前的版本不可得，改取「full 中以 a 的最後版本為頂的前綴」
      const myHeads = cg.findDominators(full.cg, full.cg.heads.slice(0, Math.max(1, a)));
      const oldBranchRef = ref.createEmptyBranch() as ref.Branch<string>;
      // 以參考實作算出舊版本文字：把 full 截到 myHeads 的祖先集合，重放
      const upto = Math.max(...myHeads) + 1;
      const cut = { ops: full.ops.slice(0, upto), cg: cg.createCG() } as ref.ListOpLog<string>;
      for (const e of full.cg.entries) {
        if (e.version >= upto) break;
        cg.add(cut.cg, e.agent, e.seq, e.seq + (Math.min(e.vEnd, upto) - e.version), e.parents);
      }
      void own; void oldBranchRef;
      const oldText = ref.checkoutSimple(cut);
      const oldVersion = cut.cg.heads.slice();
      const want = (() => {
        const b: ref.Branch<string> = { snapshot: oldText.slice(), version: oldVersion.slice() };
        ref.mergeChangesIntoBranch(b, full);
        return b.snapshot.join("");
      })();
      const b2 = makeBranch(oldText.join(""), oldVersion.slice());
      const info = mergeIntoBranch(b2, pl);
      if (info.mode === "crdt") crdt++;
      assert.equal(b2.text.toString(), want, `merge seed=${seed} a=${a} mode=${info.mode}`);
      assert.equal(b2.text.toString(), branches[0]!.snapshot.join(""), "最終文字");
    }
  }
  assert.ok(crdt > 10, `要有足夠的 CRDT 合併路徑（${crdt}）`);
});

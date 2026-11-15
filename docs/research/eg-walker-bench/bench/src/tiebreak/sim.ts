// 多副本模擬：每個副本有自己的 oplog 與文字；本機編輯、依任意（合乎因果的）順序與批次送給別的副本。
// 引擎是 variantEngine（可調先後規則），所以「歷史是用該規則產生的」——位置只在產生它的規則下有意義。
import { appendTxns, buildOpLog, makeBranch, mergeIntoBranch, replay } from "./variantEngine.js";
import type { OpLog, Branch } from "../proto/engine.js";
import type { PatchOp } from "../types.js";
import { makeRng, type Rng } from "../prng.js";

export interface Unit { agent: string; seq: number; parents: string[]; op: PatchOp }
export const keyOf = (u: { agent: string; seq: number }) => `${u.agent}#${u.seq}`;

export class Replica {
  log: OpLog = buildOpLog({ txns: [] });
  branch: Branch = makeBranch("", []);
  known = new Map<string, number>(); // 單位鍵 → LV
  order: Unit[] = [];
  constructor(readonly agent: string) {}
  get text(): string { return this.branch.text.toString(); }

  /** 本機編輯：在目前文字的 pos 插入（或刪 1 個字）。seq 是這個 agent 自己的流水號。 */
  local(units: Map<string, Unit>, op: PatchOp): Unit {
    const seq = this.log.nextSeq[this.agent] ?? 0;
    const heads = this.order.length === 0 ? [] : this.headsKeys();
    const u: Unit = { agent: this.agent, seq, parents: heads, op };
    units.set(keyOf(u), u);
    this.add(u);
    return u;
  }
  private headsKeys(): string[] {
    const cg = this.log.cg;
    return cg.heads.map((lv) => { const [a, s] = lvToRaw(this.log, lv); return `${a}#${s}`; });
  }
  has(u: Unit): boolean { return this.known.has(keyOf(u)); }
  ready(u: Unit): boolean { return u.parents.every((k) => this.known.has(k)); }
  add(u: Unit): void {
    const lv = this.order.length;
    this.log.nextSeq[u.agent] = u.seq;
    appendTxns(this.log, [{ agent: u.agent, start: lv, parents: u.parents.map((k) => this.known.get(k)!), ops: [u.op] }], false);
    this.known.set(keyOf(u), lv);
    this.order.push(u);
    mergeIntoBranch(this.branch, this.log);
  }
}
import * as cgLib from "../vendor/eg-walker-reference/causal-graph.js";
const lvToRaw = (log: OpLog, lv: number) => cgLib.lvToRaw(log.cg, lv);

/** from 有而 to 沒有的單位，以隨機的合乎因果的順序、隨機批次送過去（每批各自合併一次）。 */
export function deliver(from: Replica, to: Replica, rng: Rng): void {
  let missing = from.order.filter((u) => !to.has(u));
  while (missing.length > 0) {
    const ready = missing.filter((u) => to.ready(u));
    const batch = 1 + rng.int(Math.min(3, ready.length));
    for (let i = 0; i < batch; i++) {
      const pick = ready.splice(rng.int(ready.length), 1)[0]!;
      to.add(pick);
      missing = missing.filter((u) => u !== pick);
    }
  }
}

/** 依另一個（隨機）拓撲順序，從零重放所有單位（LV 不同、(agent,seq) 相同）。 */
export function replayInOrder(units: Unit[], rng: Rng): string {
  const log = buildOpLog({ txns: [] });
  const known = new Map<string, number>();
  let left = units.slice(), n = 0;
  while (left.length > 0) {
    const ready = left.filter((u) => u.parents.every((k) => known.has(k)));
    const u = ready[rng.int(ready.length)]!;
    log.nextSeq[u.agent] = u.seq;
    appendTxns(log, [{ agent: u.agent, start: n, parents: u.parents.map((k) => known.get(k)!), ops: [u.op] }], false);
    known.set(keyOf(u), n++);
    left = left.filter((x) => x !== u);
  }
  return replay(log);
}
export { makeRng };

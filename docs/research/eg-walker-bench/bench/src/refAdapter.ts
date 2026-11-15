// 參考實作的轉接：把 History 灌進它的 oplog（一個字元一個操作，這就是它的原樣）。
import * as ref from "./vendor/eg-walker-reference/index.js";
import * as cg from "./vendor/eg-walker-reference/causal-graph.js";
import type { History, PatchOp, Txn } from "./types.js";

export type RefLog = ref.ListOpLog<string>;

export function buildRefLog(h: History): RefLog {
  const log = ref.createOpLog<string>();
  const nextSeq: Record<string, number> = {};
  for (const t of h.txns) {
    const units = t.ops.reduce((n, o) => n + (o[1] > 0 ? o[1] : o[2].length), 0);
    const s0 = nextSeq[t.agent] ?? 0;
    nextSeq[t.agent] = s0 + units;
    cg.add(log.cg, t.agent, s0, s0 + units, t.parents);
    for (const [pos0, del, ins] of t.ops) {
      if (del > 0) for (let i = 0; i < del; i++) log.ops.push({ type: "del", pos: pos0 });
      else {
        let pos = pos0;
        for (let i = 0; i < ins.length; i++) log.ops.push({ type: "ins", pos: pos++, content: ins[i]! });
      }
    }
  }
  return log;
}

/** 參考實作的 oplog 轉回 History（每個 CG 條目一筆交易，操作逐字）。 */
export function refLogToHistory(log: RefLog): History {
  const txns: Txn[] = [];
  for (const e of log.cg.entries) {
    const ops: PatchOp[] = [];
    for (let lv = e.version; lv < e.vEnd; lv++) {
      const op = log.ops[lv]!;
      ops.push(op.type === "ins" ? [op.pos, 0, op.content as string] : [op.pos, 1, ""]);
    }
    txns.push({ agent: e.agent, start: e.version, parents: e.parents.slice(), ops });
  }
  return { txns };
}

export { ref, cg };

// 用 trace 檔自己的 (agent, seqStart) 建 oplog（原轉接層把每個 agent 的 seq 從 0 重編，見 tiebreak-findings.md）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../traces.js";
import { appendTxns, buildOpLog, type OpLog } from "../proto/engine.js";
import * as cgLib from "../vendor/eg-walker-reference/causal-graph.js";
import type { History, PatchOp, Txn } from "../types.js";

interface RawTxn { span: [number, number]; parents: number[]; agent: string; seqStart: number; ops: PatchOp[] }
const flat = (s: string): string => s.replace(/[\u{10000}-\u{10FFFF}]/gu, "�");

export interface SeqTxn extends Txn { seqStart: number }
export function loadRaw(file: string): { txns: SeqTxn[]; endContent: string } {
  const j = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as { txns: RawTxn[]; endContent: string };
  return {
    endContent: flat(j.endContent),
    txns: j.txns.map((t) => ({
      agent: t.agent, start: t.span[0], parents: t.parents, seqStart: t.seqStart,
      ops: t.ops.map(([p, d, s]): PatchOp => [p, d, flat(s)]),
    })),
  };
}

/** `mapAgent` 換 agent 名（先後規則實驗用）；seq 照檔案。 */
export function buildRealSeqLog(txns: SeqTxn[], mapAgent: (a: string) => string = (a) => a): OpLog {
  const log = buildOpLog({ txns: [] } as History);
  for (const t of txns) {
    const a = mapAgent(t.agent);
    log.nextSeq[a] = t.seqStart;
    appendTxns(log, [{ ...t, agent: a }]);
  }
  return log;
}
export { cgLib };

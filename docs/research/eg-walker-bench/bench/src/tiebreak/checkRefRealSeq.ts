// 參考實作（作者的 eg-walker-reference）用 trace 檔的真實 (agent, seq) 重放 git-makefile，約 2 分鐘。
import { loadRaw } from "./realSeq.js";
import { ref, cg } from "../refAdapter.js";
const r = loadRaw("git-makefile-raw.json");
const log = ref.createOpLog<string>();
for (const t of r.txns) {
  const units = t.ops.reduce((n, o) => n + (o[1] > 0 ? o[1] : o[2].length), 0);
  cg.add(log.cg, t.agent, t.seqStart, t.seqStart + units, t.parents);
  for (const [pos0, del, ins] of t.ops) {
    if (del > 0) for (let i = 0; i < del; i++) log.ops.push({ type: "del", pos: pos0 });
    else for (let i = 0; i < ins.length; i++) log.ops.push({ type: "ins", pos: pos0 + i, content: ins[i]! });
  }
}
const t0 = performance.now();
const out = ref.checkoutSimpleString(log);
console.log(JSON.stringify({ refMs: Math.round(performance.now() - t0), refEqualsExpected: out === r.endContent, len: out.length }));

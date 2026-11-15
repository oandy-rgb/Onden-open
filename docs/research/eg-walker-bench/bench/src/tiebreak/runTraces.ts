// 每條有預期文字的 trace × 各先後規則：重放結果是否等於預期（out/tiebreak-traces.json）。
import { writeFileSync } from "node:fs";
import { RULES, buildOpLog, replay, withRule } from "./variantEngine.js";
import { buildRealSeqLog, loadRaw } from "./realSeq.js";
import { loadTrace } from "../traces.js";

type Row = Record<string, string>;
const rows: Record<string, Row> = {};
const run = (id: string, fn: () => string, expected: string) => {
  rows[id] = {};
  for (const [name, rule] of Object.entries(RULES)) {
    try { rows[id]![name] = withRule(rule, fn) === expected ? "符合" : "不符"; } catch (e) { rows[id]![name] = `重放失敗：${(e as Error).message}`; }
  }
};
for (const [file, id] of [["ff-raw.json", "friendsforever"], ["git-makefile-raw.json", "git-makefile"], ["node_nodecc-raw.json", "node_nodecc"]] as const) {
  const r = loadRaw(file); run(`${id}（真實 seq）`, () => replay(buildRealSeqLog(r.txns)), r.endContent);
}
{ const r = loadRaw("git-makefile-raw.json"); run("git-makefile（舊轉接：seq 照到達順序重編）", () => replay(buildOpLog({ txns: r.txns })), r.endContent); }
for (const id of ["clownschool", "automerge-paper", "seph-blog1"]) { const t = loadTrace(id); run(id, () => replay(buildOpLog(t.history)), t.history.endContent!); }
console.table(rows);
writeFileSync(new URL("../../out/tiebreak-traces.json", import.meta.url), JSON.stringify(rows, null, 2) + "\n");

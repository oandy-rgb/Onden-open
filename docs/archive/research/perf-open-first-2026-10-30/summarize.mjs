// 時間軸 JSON 彙整成分段表（中位數）。usage: node summarize.mjs <label>:<檔名> ...  例：node summarize.mjs 改前:timeline-base10-20k-phone.json 改後:timeline-after4-20k-phone.json,timeline-after4b-20k-phone.json
import { readFileSync } from "node:fs";
const med = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const bootstrapEnd = (x) => x.api.find((a) => /\/api\/bootstrap\?bodies=none$/.test(a.path))?.endMs ?? null;
const syncStart = (x) => x.api.find((a) => /^\/api\/sync$/.test(a.path))?.startMs ?? null;
for (const arg of process.argv.slice(2)) {
  const [label, files] = arg.split(":");
  const runs = files.split(",").flatMap((f) => JSON.parse(readFileSync(f, "utf8"))).filter((r) => !r.error);
  console.log(`\n## ${label}（${runs.length} 次）`);
  for (const k of ["cold", "warm", "offline"]) {
    const xs = runs.map((r) => r[k]).filter(Boolean);
    const row = {
      殼: med(xs.map((x) => x.marks.shell)),
      下載完: k === "cold" ? med(xs.map(bootstrapEnd)) : null,
      鏡像寫入開始: med(xs.map((x) => x.persistBootstrap[0]?.startMs)),
      鏡像寫入結束: med(xs.map((x) => x.persistBootstrap[0]?.endMs)),
      核對閘門升起: med(xs.map((x) => x.marks.gateUp)),
      核對閘門放下: med(xs.map((x) => x.marks.gateDown)),
      可打字: med(xs.map((x) => x.marks.typableLast ?? x.marks.usable)),
      打字延遲中位: med(xs.map((x) => x.typing?.medianMs)),
      打字延遲p95: med(xs.map((x) => x.typing?.p95Ms)),
      打字延遲最大: med(xs.map((x) => x.typing?.maxMs)),
      可打字前long任務合計: med(xs.map((x) => x.longTasksToTypable?.sum)),
      可打字前最長long任務: med(xs.map((x) => x.longTasksToTypable?.max)),
    };
    console.log(k, JSON.stringify(row));
  }
}

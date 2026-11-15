// Medians (and min–max) per tier × device from results/results-*.json and results/results2-*.json, plus backend API table.
// usage: node aggregate.mjs   (run in this directory)
import { readFileSync, existsSync } from "node:fs";
const tiers = ["1k", "5k", "20k"], devices = ["desktop", "phone"];
const med = (xs) => { const s = xs.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const rng = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? `${s[0]}–${s[s.length - 1]}` : "–"; };
const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).filter((r) => !r.error).map((r) => { for (const k of ["cold", "warm", "offline"]) { const m = r[k]?.marks; if (m && m.gateUp !== undefined && m.gateDown !== undefined) r[k].gateMs = m.gateDown - m.gateUp; } return r; }) : []);
const get = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const cell = (rs, p) => { const v = rs.map((r) => get(r, p)).filter((x) => typeof x === "number"); return v.length ? `${med(v)} (${rng(v)}) n=${v.length}` : "未量"; };
const M1 = [["冷開 usable ms", "cold.marks.usable"], ["冷開 shell ms", "cold.marks.shell"], ["冷開 gate 持續 ms", "cold.gateMs"], ["冷開 bootstrap JS KB", "cold.net.kbJs"], ["冷開 API 傳輸 KB", "cold.net.kbApi"], ["冷開 鏡像寫完 ms(usable後)", "cold.mirrorSettledAfterUsableMs"], ["鏡像 DB bytes", "mirrorBytes"], ["冷開 long task 總和 ms", "cold.ltToUsable.sum"],
  ["熱開 usable ms", "warm.marks.usable"], ["熱開 gate ms", "warm.gateMs"], ["離線熱開 usable ms", "offline.marks.usable"],
  ["切換 短筆記 ms", "open.short.ms"], ["切換 50k 長筆記 ms", "open.long50k.ms"], ["切換 300 反向連結 ms", "open.hub300.ms"],
  ["打字 50k median ms", "typing.medianMs"], ["打字 p95 ms", "typing.p95Ms"], ["自動保存 最後按鍵→送出 ms", "autosave.lastKeyToSentMs"], ["自動保存 請求來回 ms", "autosave.roundTripMs"], ["自動保存 請求 bytes", "autosave.reqBytes"], ["自動保存 最後按鍵→已保存 ms", "autosave.lastKeyToSavedMs"],
  ["⌘K 標題查詢 最後按鍵→結果 ms", "search.0.lastKeyToResultMs"], ["⌘K 常見詞 最後按鍵→結果 ms", "search.1.lastKeyToResultMs"], ["⌘K 常見詞 按鍵→畫面 median ms", "search.1.keyMedianMs"], ["同步 遠端編輯→套用 ms", "sync.appliedAfterEditMs"]];
const M2 = [["展開全部 → DOM 穩定 ms", "expandAll.msToSettled"], ["切換 短筆記(measure2) ms", "switchShort.0.ms"], ["切換 50k長筆記(measure2) ms", "switchShort.1.ms"], ["打字 5k字 key→frame median ms", "typing5k.keyToFrameMedianMs"], ["打字 5k字 p95 ms", "typing5k.p95Ms"], ["打字 5k字 Event Timing 最大 ms", "typing5k.eventTimingMaxMs"],
  ["白板 點分頁→卡片 ms", "whiteboard.tabToCardsMs"], ["白板 long task 總和 ms", "whiteboard.lt.sum"], ["白板 平移 fps", "whiteboard.paneDrag.avgFps"], ["白板 平移 p95 幀 ms", "whiteboard.paneDrag.p95FrameMs"], ["白板 拖卡 fps", "whiteboard.cardDrag.avgFps"], ["白板 拖卡 p95 幀 ms", "whiteboard.cardDrag.p95FrameMs"],
  ["PDF 開啟→首頁 ms", "pdf.openToFirstPageMs"], ["PDF 捲動 fps", "pdf.scroll.avgFps"], ["PDF 捲動 p95 幀 ms", "pdf.scroll.p95FrameMs"], ["歷史 開啟→清單 ms", "history.openToListMs"], ["歷史 long task 總和 ms", "history.lt.sum"]];
for (const [title, set, prefix, M] of [["舊指標 (measure.mjs)", "results", "results", M1], ["新指標 (measure2.mjs)", "results2", "results2", M2]]) {
  console.log(`\n## ${title}`);
  for (const dev of devices) {
    console.log(`\n### ${dev}\n| 指標 | ${tiers.join(" | ")} |\n|---|${tiers.map(() => "---").join("|")}|`);
    const data = tiers.map((t) => load(`results/${prefix}-${t}-${dev}.json`));
    for (const [name, p] of M) console.log(`| ${name} | ${data.map((d) => cell(d, p)).join(" | ")} |`);
  }
}
// backend API table from results/backend-<tier>-*.log: "[http] METHOD path status ms"
console.log("\n## 後端 API (backend log; /api/health 排除)");
for (const tier of tiers) {
  const by = new Map();
  for (const suf of ["desktop", "phone", "desktop-phone"]) {
    const f = `results/backend-${tier}-${suf}.log`; if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\[http\] (GET|POST|PATCH|PUT|DELETE) (\S+) (\d+) (\d+)ms/); if (!m || m[2].startsWith("/api/health")) continue;
      const path = m[2].split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/[0-9a-f]{32}\.\w+/g, ":file");
      const k = `${m[1]} ${path}`; (by.get(k) ?? by.set(k, []).get(k)).push(Number(m[4]));
    }
  }
  const rows = [...by].map(([k, v]) => { const s = [...v].sort((a, b) => a - b); return { k, n: v.length, p50: s[s.length >> 1], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; }).filter((r) => r.n >= 3).sort((a, b) => b.p95 - a.p95).slice(0, 8);
  console.log(`\n### ${tier}\n| 路由 | 次數 | p50 | p95 | max |\n|---|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r.k} | ${r.n} | ${r.p50} | ${r.p95} | ${r.max} |`);
}

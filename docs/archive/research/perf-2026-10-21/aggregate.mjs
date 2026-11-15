// Medians (and min–max) per tier × device from results-<tier>-<device>.json.
import { readFileSync, existsSync } from "node:fs";
const tiers = ["1k", "5k", "20k"], devices = ["desktop", "phone"];
const med = (xs) => { const s = xs.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const rng = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? `${s[0]}–${s[s.length - 1]}` : "–"; };
const api = (net, re) => (net?.api ?? []).filter((a) => re.test(a.p));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const metrics = {
  "冷啟動 shell 出現 (ms)": (r) => r.cold?.marks?.shell,
  "冷啟動 第一列出現 (ms)": (r) => r.cold?.marks?.firstRow,
  "冷啟動 可操作 usable (ms)": (r) => r.cold?.marks?.usable,
  "冷啟動 gate 出現→消失 (ms)": (r) => r.cold?.marks?.gateDown != null ? r.cold.marks.gateDown - r.cold.marks.gateUp : 0,
  "冷啟動 initLocalDb (ms)": (r) => r.cold?.initLocalDb?.[0],
  "bootstrap 壓縮後 (KB)": (r) => Math.round(sum(api(r.cold?.net, /^\/api\/bootstrap/).map((a) => a.encKB))),
  "bootstrap 原始 (KB)": (r) => Math.round(sum(api(r.cold?.net, /^\/api\/bootstrap/).map((a) => a.rawKB))),
  "bootstrap 時間 (ms)": (r) => sum(api(r.cold?.net, /^\/api\/bootstrap/).map((a) => a.ms)),
  "冷啟動後背景下載 bodies 次數": (r) => api(r.cold?.net, /^\/api\/sync\/bodies/).length,
  "冷啟動後背景下載 bodies+drawings 原始 (KB)": (r) => Math.round(sum(api(r.cold?.net, /^\/api\/sync\/(bodies|drawings)/).map((a) => a.rawKB))),
  "冷啟動 API 總傳輸 (KB 壓縮)": (r) => r.cold?.net?.kbApi,
  "冷啟動 JS (KB 壓縮)": (r) => r.cold?.net?.kbJs,
  "鏡像 DB 落地完成（usable 後, ms）": (r) => r.cold?.mirrorSettledAfterUsableMs,
  "本機鏡像 DB 大小 (MB)": (r) => r.mirrorBytes ? +(r.mirrorBytes / 1048576).toFixed(1) : null,
  "冷啟動 long task 到 usable：總和 (ms)": (r) => r.cold?.ltToUsable?.sum,
  "冷啟動 long task 到 usable：最長 (ms)": (r) => r.cold?.ltToUsable?.max,
  "冷啟動 long task 含背景落地：總和 (ms)": (r) => r.cold?.ltUntilSettled?.sum,
  "JS heap（usable 時, MB）": (r) => r.cold?.heapAtUsableMb,
  "JS heap（落地後, MB）": (r) => r.cold?.heapSettledMb,
  "熱啟動 usable (ms)": (r) => r.warm?.marks?.usable,
  "熱啟動 第一列 (ms)": (r) => r.warm?.marks?.firstRow,
  "熱啟動 gate 出現→消失 (ms)": (r) => r.warm?.marks?.gateDown != null ? r.warm.marks.gateDown - r.warm.marks.gateUp : 0,
  "熱啟動 initLocalDb (ms)": (r) => r.warm?.initLocalDb?.[0],
  "熱啟動 loadBootstrap (ms)": (r) => r.warm?.loadBootstrap?.[0],
  "熱啟動 long task 總和 (ms)": (r) => r.warm?.ltToUsable?.sum,
  "熱啟動 JS heap (MB)": (r) => r.warm?.heapMb,
  "離線熱啟動 usable (ms)": (r) => r.offline?.marks?.usable,
  "開短筆記 (ms)": (r) => r.open?.short?.ms,
  "開 50k 字長筆記 (ms)": (r) => r.open?.long50k?.ms,
  "開 300 反向連結筆記 (ms)": (r) => r.open?.hub300?.ms,
  "開 300 反向連結：反向連結卡片出現 (ms)": (r) => r.open?.hub300?.backlinksMs,
  "切換筆記 long task 最長 (ms)": (r) => Math.max(r.open?.short?.lt?.max ?? 0, r.open?.long50k?.lt?.max ?? 0, r.open?.hub300?.lt?.max ?? 0),
  "長筆記打字 input→paint 中位數 (ms)": (r) => r.typing?.medianMs,
  "長筆記打字 p95 (ms)": (r) => r.typing?.p95Ms,
  "長筆記打字 最大 (ms)": (r) => r.typing?.maxMs,
  "自動保存：最後按鍵→送出 (ms)": (r) => r.autosave?.lastKeyToSentMs,
  "自動保存：來回 (ms)": (r) => r.autosave?.roundTripMs,
  "自動保存：最後按鍵→已保存 (ms)": (r) => r.autosave?.lastKeyToSavedMs,
  "指令面板 標題查詢：最後按鍵→結果 (ms)": (r) => r.search?.[0]?.lastKeyToResultMs,
  "指令面板 常見詞查詢：最後按鍵→結果 (ms)": (r) => r.search?.[1]?.lastKeyToResultMs,
  "同步：遠端編輯→本頁套用 (ms)": (r) => r.sync?.appliedAfterEditMs,
  "同步：delta 請求數": (r) => r.sync?.api?.length,
  "同步：delta 傳輸 (KB 壓縮)": (r) => r.sync?.api ? +sum(r.sync.api.map((a) => a.encKB)).toFixed(1) : null,
};
const data = {};
for (const t of tiers) for (const d of devices) {
  const f = `results-${t}-${d}.json`;
  if (existsSync(f)) data[`${t}-${d}`] = JSON.parse(readFileSync(f, "utf8")).filter((r) => !r.error);
}
for (const d of devices) {
  console.log(`\n### ${d === "phone" ? "手機模擬（390×844、CPU 4×、150 ms RTT／9 Mbps）" : "桌面 Chromium（不降速）"}\n`);
  console.log(`| 指標 | ${tiers.map((t) => `${t}（n）`).join(" | ")} |`);
  console.log(`|---|${tiers.map(() => "---").join("|")}|`);
  for (const [name, fn] of Object.entries(metrics)) {
    const cells = tiers.map((t) => { const rs = data[`${t}-${d}`]; if (!rs?.length) return "–"; const xs = rs.map((r) => { try { return fn(r); } catch { return null; } }); const m = med(xs); return m == null ? "–" : `${m} <sub>(${rng(xs)}, n=${xs.filter((x) => typeof x === "number").length})</sub>`; });
    console.log(`| ${name} | ${cells.join(" | ")} |`);
  }
}
// errors
for (const t of tiers) for (const d of devices) {
  const f = `results-${t}-${d}.json`;
  if (!existsSync(f)) continue;
  const all = JSON.parse(readFileSync(f, "utf8"));
  const errs = all.flatMap((r) => [r.error, r.typing?.error, r.sync?.error, r.offline?.error, ...Object.values(r.open ?? {}).map((o) => o.error), ...(r.search ?? []).map((s) => s.error)].filter(Boolean));
  if (errs.length) console.log(`\n${t}-${d} errors:`, errs.map((e) => e.slice(0, 100)));
}

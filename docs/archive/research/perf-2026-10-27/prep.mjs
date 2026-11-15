// Prepares a restored perf copy (NEVER the onden_mperf_* snapshots): adds a
// ~50k-char note and a hub note that 300 other notes link to, through the API.
// usage: BASE=http://localhost:5099 node prep.mjs
const BASE = process.env.BASE || "http://localhost:5099";
const H = { origin: BASE, "content-type": "application/json" };
let cookie = "";
async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { ...H, cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const WORDS = "知識 管理 筆記 想法 系統 設計 資料 同步 離線 手機 效能 測試 演算法 作業 期中 報告 讀書 會議 專案 計畫".split(" ");
const para = (i, n) => { let s = ""; for (let k = 0; k < n; k++) s += WORDS[(i * 7 + k * 3) % WORDS.length]; return s + "。"; };
function longBody(target) {
  const out = ["# 效能長筆記", ""];
  let k = 0;
  while (out.join("\n").length < target) {
    if (k % 30 === 0) out.push("", `## 第 ${k / 30 + 1} 節`, "");
    else if (k % 11 === 0) out.push("```ts", `function f${k}(x: number) { return x * ${k}; }`, "```");
    else if (k % 7 === 0) out.push(`- 項目 ${k}，參考 [[筆記 ${k % 900}]]`);
    else if (k % 17 === 0) out.push(`- [ ] 待辦事項 ${k}`);
    else out.push(para(k, 30 + (k % 25)));
    k++;
  }
  return out.join("\n");
}
async function main() {
  const s = await req("POST", "/api/auth/sign-in/email", { email: "perf-owner@example.com", password: "perf-pass-12345" });
  if (s.status !== 200) throw new Error("signin " + s.status);
  const boot = await req("GET", "/api/bootstrap?bodies=none");
  const nodes = boot.json.nodes.filter((n) => n.node_type === "content");
  const byTitle = new Map(nodes.map((n) => [n.title, n]));
  if (!byTitle.has("效能長筆記")) {
    const md = longBody(50_000);
    const r = await req("POST", "/api/nodes", { title: "效能長筆記", markdown: md });
    console.log("long note", r.status, md.length);
  }
  if (!byTitle.has("效能樞紐筆記")) {
    const r = await req("POST", "/api/nodes", { title: "效能樞紐筆記", markdown: "這篇筆記被很多筆記連到，用來量反向連結多的筆記開啟速度。\n\n## 摘要\n\n" + para(1, 40) });
    console.log("hub", r.status);
    const sources = nodes.filter((n) => /^筆記 \d+$/.test(n.title)).slice(0, 300);
    let ok = 0;
    for (let i = 0; i < sources.length; i += 10) {
      await Promise.all(sources.slice(i, i + 10).map(async (n) => {
        const full = await req("GET", `/api/nodes/${n.id}`);
        const md = (full.json.markdown ?? "") + "\n\n參見 [[效能樞紐筆記]]";
        const p = await req("PATCH", `/api/nodes/${n.id}`, { markdown: md, base_markdown: full.json.markdown ?? "" });
        if (p.status === 200) ok++; else console.log("patch", p.status, JSON.stringify(p.json).slice(0, 200));
      }));
    }
    console.log("backlinks added", ok);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

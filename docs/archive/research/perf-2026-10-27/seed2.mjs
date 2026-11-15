// Bulk seeding through POST /api/import/obsidian (one transaction per batch). Used for 5k→20k because one-by-one
// POST /api/nodes costs O(workspace) per note (backlink scan, see report) and would take > 1 h at 20k.
// Same shape as seed.mjs: [[link]] to the previous note, #tag via frontmatter, 1 in 4 notes under one of 100 folders, every 50th ~24k chars.
// usage: BASE=http://localhost:5099 node seed2.mjs <from> <to> [batch=250]
const BASE = process.env.BASE || "http://localhost:5099";
const [FROM, TO, BATCH = 250] = process.argv.slice(2).map(Number);
const H = { origin: BASE, "content-type": "application/json" };
const s = await fetch(BASE + "/api/auth/sign-in/email", { method: "POST", headers: H, body: JSON.stringify({ email: "perf-owner@example.com", password: "perf-pass-12345" }) });
const cookie = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const WORDS = "知識 管理 筆記 想法 系統 設計 資料 同步 離線 手機 效能 測試 演算法 作業 期中 報告 讀書 會議 專案 計畫".split(" ");
const para = (i, n) => { let x = ""; for (let k = 0; k < n; k++) x += WORDS[(i * 7 + k * 3) % WORDS.length]; return x + "。"; };
const body = (i, len) => { const out = ["---", `tags: [標籤${i % 30}]`, "---", `# 筆記 ${i}`, "", `第 ${i} 篇合成筆記。`, ""]; if (i > 0) out.push(`相關：[[筆記 ${i - 1}]]`, ""); out.push("- 項目 A", "- 項目 B", `- [ ] 待辦 ${i}`, ""); let k = 0; while (out.join("\n").length < len) out.push(para(i + k, 30 + (k % 25)), ""), k++; return out.join("\n"); };
const t0 = Date.now(); let fail = 0;
for (let a = FROM; a < TO; a += BATCH) {
  const files = []; for (let i = a; i < Math.min(TO, a + BATCH); i++) files.push({ path: `${i % 4 === 1 ? `匯入資料夾 ${(i >> 2) % 100}/` : ""}筆記 ${i}.md`, content: body(i, i % 50 === 0 ? 24_000 : 300) });
  const r = await fetch(BASE + "/api/import/obsidian", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ files, source: { id: "00000000-0000-4000-8000-0000000000" + String(a % 100).padStart(2, "0"), name: "perf" } }) });
  const j = await r.text(); if (r.status !== 200) { fail++; console.log("batch", a, r.status, j.slice(0, 200)); }
  if (a === FROM) console.log("first batch", r.status, j.slice(0, 300));
  console.log(`${Math.min(TO, a + BATCH) - FROM}/${TO - FROM} ${Math.round((Date.now() - t0) / 1000)}s`);
}
console.log("done fail", fail);

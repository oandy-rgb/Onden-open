// New 2026-10-27 fixtures (idempotent, by title): 5k-char note, unique short note, 200-card whiteboard, 20-page PDF.
// usage: BASE=http://localhost:5099 node prep2.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:5099";
const H = { origin: BASE };
let cookie = "";
async function req(method, path, body, raw) {
  const r = await fetch(BASE + path, { method, headers: { ...H, ...(raw ? {} : { "content-type": "application/json" }), cookie }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? []; if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const WORDS = "知識 管理 筆記 想法 系統 設計 資料 同步 離線 手機 效能 測試 演算法 作業 期中 報告 讀書 會議 專案 計畫".split(" ");
const para = (i, n) => { let s = ""; for (let k = 0; k < n; k++) s += WORDS[(i * 7 + k * 3) % WORDS.length]; return s + "。"; };
await req("POST", "/api/auth/sign-in/email", { email: "perf-owner@example.com", password: "perf-pass-12345" });
const nodes = (await req("GET", "/api/bootstrap?bodies=none")).json.nodes.filter((n) => n.node_type === "content");
const has = (t) => nodes.find((n) => n.title === t);
if (!has("效能五千字筆記")) {
  const out = ["# 效能五千字筆記", ""]; let k = 0;
  while (out.join("\n").length < 5000) out.push(para(k++, 40), "");
  console.log("5k note", (await req("POST", "/api/nodes", { title: "效能五千字筆記", markdown: out.join("\n") })).status);
}
if (!has("效能短筆記")) console.log("short", (await req("POST", "/api/nodes", { title: "效能短筆記", markdown: "唯一詞彙：夸克螺旋。這是用來量切換速度的短筆記。" })).status);
if (!has("效能白板")) {
  const c = await req("POST", "/api/canvases", { title: "效能白板" });
  const cards = nodes.filter((n) => /^筆記 \d+$/.test(n.title)).slice(0, 200).map((n, i) => ({ nodeId: n.id, x: (i % 20) * 340, y: Math.floor(i / 20) * 260, width: 300, height: 220 }));
  console.log("canvas", c.status, "cards", (await req("PATCH", `/api/boards/${c.json.id}`, { cards: { upsert: cards } })).status, cards.length);
}
if (!has("效能PDF")) {
  const b = await chromium.launch(); const p = await b.newPage();
  const pages = Array.from({ length: 20 }, (_, i) => `<section style="page-break-after:always;font:16px serif;padding:20px"><h1>第 ${i + 1} 頁</h1>${Array.from({ length: 14 }, (_, j) => `<p>${para(i * 20 + j, 90)}</p>`).join("")}<svg width="400" height="120"><rect x="5" y="5" width="390" height="110" fill="none" stroke="#333"/><circle cx="60" cy="60" r="40" fill="#c33"/></svg></section>`).join("");
  await p.setContent(`<html><body style="margin:0">${pages}</body></html>`);
  const pdf = await p.pdf({ format: "A4" }); await b.close();
  const fd = new FormData(); fd.append("file", new Blob([pdf], { type: "application/pdf" }), "perf.pdf");
  const up = await req("POST", "/api/media", fd, true);
  console.log("upload", up.status, up.json.url, pdf.length);
  console.log("pdf note", (await req("POST", "/api/nodes", { title: "效能PDF", markdown: "", attributes: [{ key: "pdf_url", value: up.json.url }] })).status);
}

// Seeds a perf workspace through the real HTTP API (fresh DB: first signup = owner).
// usage: BASE=http://localhost:5099 node seed.mjs <from> <to>   (note numbers, inclusive-exclusive; first call also signs up + makes tags/folders)
// Shape (mirrors 10-21): ~300-char notes with a [[link]] to the previous note, 30 tags (3 nested), 5% of notes
// sit under one of 100 "資料夾 N" folder notes, every 50th note ~24k chars, one 184k-char note, every 200th with ink.
const BASE = process.env.BASE || "http://localhost:5099";
const [FROM = 0, TO = 1000] = process.argv.slice(2).map(Number);
const AUTH = { email: "perf-owner@example.com", password: "perf-pass-12345", name: "perf-owner" };
const H = { origin: BASE, "content-type": "application/json" };
let cookie = "";
async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { ...H, cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const WORDS = "知識 管理 筆記 想法 系統 設計 資料 同步 離線 手機 效能 測試 演算法 作業 期中 報告 讀書 會議 專案 計畫".split(" ");
const para = (i, n) => { let s = ""; for (let k = 0; k < n; k++) s += WORDS[(i * 7 + k * 3) % WORDS.length]; return s + "。"; };
const body = (i, len) => {
  const out = [`# 筆記 ${i}`, "", `第 ${i} 篇合成筆記。`, ""];
  if (i > 0) out.push(`相關：[[筆記 ${i - 1}]]`, "");
  out.push("- 項目 A", "- 項目 B", `- [ ] 待辦 ${i}`, "");
  let k = 0; while (out.join("\n").length < len) out.push(para(i + k, 30 + (k % 25)), ""), k++;
  return out.join("\n");
};
async function main() {
  let s = await req("POST", "/api/auth/sign-up/email", AUTH);
  if (s.status >= 400) s = await req("POST", "/api/auth/sign-in/email", AUTH);
  if (s.status >= 400) throw new Error("auth " + s.status + JSON.stringify(s.json));
  const tags = await req("GET", "/api/tags");
  let tagIds = tags.json.filter((t) => /^標籤/.test(t.name)).map((t) => t.id);
  if (tagIds.length < 30) {
    tagIds = [];
    for (let t = 0; t < 30; t++) {
      const r = await req("POST", "/api/tags", { name: `標籤${t}`, parent_id: t >= 27 ? tagIds[t - 27] : undefined });
      if (r.status !== 201) throw new Error("tag " + r.status + JSON.stringify(r.json));
      tagIds.push(r.json.id);
    }
  }
  const nodes = (await req("GET", "/api/bootstrap?bodies=none")).json.nodes ?? [];
  const folders = nodes.filter((n) => /^資料夾 \d+$/.test(n.title)).map((n) => n.id);
  if (folders.length < 100) for (let f = folders.length; f < 100; f++) { const r = await req("POST", "/api/nodes", { title: `資料夾 ${f}`, markdown: `# 資料夾 ${f}\n` }); folders.push(r.json.id); }
  const todo = []; for (let i = FROM; i < TO; i++) todo.push(i);
  let done = 0, fail = 0; const t0 = Date.now();
  const worker = async () => {
    for (let i; (i = todo.shift()) !== undefined;) {
      const len = i === 3 ? 184_000 : i % 50 === 0 ? 24_000 : 300;
      const p = { title: `筆記 ${i}`, markdown: body(i, len), tag_ids: [tagIds[i % 30], ...(i % 4 === 0 ? [tagIds[(i * 7) % 30]] : [])].filter((x, j, a) => a.indexOf(x) === j) };
      if (i % 20 === 5) p.parent_id = folders[(i / 20 | 0) % 100];
      const r = await req("POST", "/api/nodes", p);
      if (r.status !== 201) { fail++; if (fail < 5) console.log("fail", i, r.status, JSON.stringify(r.json).slice(0, 200)); }
      if (++done % 1000 === 0) console.log(`${done}/${TO - FROM} ${Math.round((Date.now() - t0) / 1000)}s fail=${fail}`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.CONC || 8) }, worker));
  console.log("done", done, "fail", fail, Math.round((Date.now() - t0) / 1000) + "s");
}
main().catch((e) => { console.error(e); process.exit(1); });

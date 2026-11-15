#!/usr/bin/env node
// 量測：冷啟動／熱啟動、閒置記憶體、5,000 篇中文筆記的建立速度與中文搜尋延遲。
//   xvfb-run -a node test/bench.mjs [--notes 5000] [--app <執行檔>]
// 結果印成表格，寫進 PR 說明；不是自動測試（數字跟機器有關）。
import { _electron as electron } from "playwright-core";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, "..", "src", "main.mjs");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const NOTES = Number(arg("--notes", "5000"));
const exe = arg("--app", undefined);
const userData = mkdtempSync(join(tmpdir(), "onden-desktop-bench-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

async function launch() {
  const args = [...(exe ? [] : [main]), `--user-data-dir=${userData}`, "--lang=zh-TW"];
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const t0 = Date.now();
  const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args, env: { ...process.env, LANG: "zh_TW.UTF-8" } });
  const lines = [];
  app.process().stdout?.on("data", (d) => lines.push(String(d)));
  const page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 180_000 });
  await page.locator("input[type=email], .cm-content, nav").first().waitFor({ timeout: 120_000 });
  return { app, page, ms: Date.now() - t0, lines };
}

/** 這個 Electron 程序底下所有程序的記憶體（PSS，共用頁只算一份比例；RSS 會重複算）。 */
function memory(rootPid) {
  const children = new Map();
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const ppid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) \S+ /, "").split(" ")[0]);
      (children.get(ppid) ?? children.set(ppid, []).get(ppid)).push(Number(pid));
    } catch { /* 程序剛結束 */ }
  }
  const all = [];
  const walk = (pid) => { all.push(pid); (children.get(pid) ?? []).forEach(walk); };
  walk(rootPid);
  let pss = 0, rss = 0;
  const rows = [];
  for (const pid of all) {
    try {
      const smaps = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      const p = Number(/Pss:\s+(\d+)/.exec(smaps)?.[1] ?? 0), r = Number(/Rss:\s+(\d+)/.exec(smaps)?.[1] ?? 0);
      pss += p; rss += r;
      rows.push({ role: readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("serverEntry") ? "後端(Node)" : readFileSync(`/proc/${pid}/cmdline`, "utf8").match(/--type=(\w[\w-]*)/)?.[1] ?? "主程序", mb: Math.round(p / 1024) });
    } catch { /* 略過 */ }
  }
  return { pssMb: Math.round(pss / 1024), rssMb: Math.round(rss / 1024), rows };
}

const WORDS = ["資料庫", "演算法", "作業系統", "編譯器", "網路協定", "死結", "排程", "記憶體管理", "檔案系統", "虛擬記憶體", "資料結構", "二元搜尋樹", "雜湊表", "圖論", "動態規劃", "機器學習", "離散數學", "線性代數", "計算機組織", "軟體工程"];
const noteText = (i) => {
  const a = WORDS[i % WORDS.length], b = WORDS[(i * 7 + 3) % WORDS.length], c = WORDS[(i * 13 + 5) % WORDS.length];
  const para = `今天讀了${a}的章節，重點是${b}與${c}之間的關係。第${i}號筆記：老師說期中考會出${a}的證明題，要記得複習${b}。`;
  return { title: `${a}筆記 ${i}`, markdown: `# ${a}筆記 ${i}\n\n${Array.from({ length: 8 }, (_, k) => `${para}（第 ${k + 1} 段，編號 ${i}-${k}）`).join("\n\n")}\n` };
};

let session;
try {
  // 1) 第一次（含建資料庫）
  session = await launch();
  const first = { windowMs: session.ms, backendMs: Number(session.lines.join("").match(/backend ready in (\d+) ms/)?.[1]) };
  const origin = new URL(session.page.url()).origin;

  // 2) 建帳號（API，取 cookie）
  const signup = await fetch(`${origin}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ name: "壓測", email: "bench@onden.local", password: "correct-horse-battery" }) });
  if (!signup.ok) throw new Error(`sign-up ${signup.status}`);
  const cookie = signup.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const api = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { cookie, origin, "content-type": "application/json", ...(init.headers ?? {}) } });

  // 3) 灌筆記（並行 4）
  const tCreate = Date.now();
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= NOTES) return;
      const res = await api("/api/nodes", { method: "POST", body: JSON.stringify(noteText(i)) });
      if (!res.ok) { failed++; if (failed < 3) console.log("create failed", res.status, (await res.text()).slice(0, 120)); }
    }
  }));
  const createMs = Date.now() - tCreate;

  // 4) 搜尋延遲
  const queries = { "兩字中文「死結」": "死結", "一字中文「樹」": "樹", "四字中文「作業系統」": "作業系統", "多詞「記憶體 證明題」": "記憶體 證明題", "編號（唯一命中）": "編號 4321-5", "查不到": "不存在的詞彙" };
  const searchRows = [];
  for (const [label, q] of Object.entries(queries)) {
    const times = []; let hits = 0;
    for (let k = 0; k < 15; k++) {
      const t = performance.now();
      const res = await api(`/api/nodes/search?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      times.push(performance.now() - t);
      hits = Array.isArray(body) ? body.length : (body.results?.length ?? body.nodes?.length ?? -1);
    }
    searchRows.push({ label, hits, medianMs: Math.round(median(times)), p95Ms: Math.round(p95(times)) });
  }

  // 5) 閒置記憶體（灌完、安靜 30 秒後）
  await sleep(30_000);
  const idleWithData = memory(session.app.process().pid);

  // 6) 關掉；資料量
  const t1 = Date.now();
  await session.app.close();
  const closeMs = Date.now() - t1;
  const dbMb = Math.round(Number(execSync(`du -sk ${join(userData, "pgdata")}`).toString().split("\t")[0]) / 1024);

  // 7) 熱啟動（5,000 篇）
  session = await launch();
  const warmWithData = session.ms;
  await sleep(10_000);
  const idleWarm = memory(session.app.process().pid);
  const count = await (async () => { const res = await fetch(`${session.page.url().replace(/\/$/, "")}/health`); return res.status; })();
  await session.app.close();
  session = null;

  console.log(JSON.stringify({ NOTES, first, createMs, createPerSec: Math.round(NOTES / (createMs / 1000)), failed, searchRows, idleWithData, idleWarm, closeMs, dbMb, warmWithData, health: count }, null, 2));
} finally {
  await session?.app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}

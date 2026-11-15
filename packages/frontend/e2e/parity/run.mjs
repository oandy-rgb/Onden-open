#!/usr/bin/env node
// 三個宿主、同一份劇本、逐步比對。用法（根目錄 `npm run parity`）：
//   node packages/frontend/e2e/parity/run.mjs [--hosts node,desktop,browser] [--desktop-app <執行檔>] [--keep] [--update-report <檔>]
// 說明與驗收流程：docs/agents/testing.md「三個宿主的對照測試」。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript } from "./script.mjs";
import { projections } from "./projections.mjs";
import { normalizeLog } from "./normalize.mjs";
import { compareHosts, loadKnownDifferences, summarize } from "./compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
// Node 後端是比對的基準，沒點名也要跑；它排第一個。
const wanted = [...new Set(["node", ...(flag("hosts") ?? "node,desktop,browser").split(",").map((s) => s.trim()).filter(Boolean)])];

// 桌面版要有螢幕：Linux 沒有 DISPLAY 時整個指令包進 xvfb-run 重跑一次。
if (wanted.includes("desktop") && process.platform === "linux" && !process.env.DISPLAY && !process.env.PARITY_XVFB) {
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync("xvfb-run", ["-a", process.execPath, fileURLToPath(import.meta.url), ...argv], { stdio: "inherit", env: { ...process.env, PARITY_XVFB: "1" } });
  process.exit(child.status ?? 1);
}

/** 劇本看到的 API：call 記一步，name 登記 id → 名字。 */
function makeApi(host) {
  const log = [];
  const names = new Map();
  const seenSteps = new Map();
  const api = {
    log, names,
    name(label, id) {
      if (typeof id !== "string" || !id) throw new Error(`「${label}」沒有拿到 id（前一步失敗？）`);
      names.set(id, label);
      return id;
    },
    rename(id, label) { if (id) names.set(id, label); },
    async call(stepName, method, path, opts = {}) {
      // 步驟名稱是比對的鍵：同一個名字第二次出現（迴圈、取 id 的內部讀取）自動加 #2、#3，三個宿主加的一樣。
      const times = (seenSteps.get(stepName) ?? 0) + 1;
      seenSteps.set(stepName, times);
      const step = times === 1 ? stepName : `${stepName} #${times}`;
      let res;
      try {
        res = await host.request({ method, path, json: opts.json, upload: opts.upload, binary: opts.binary, headers: opts.headers, raw: opts.raw });
      } catch (error) {
        res = { status: 0, contentType: null, body: { transportError: String(error?.message ?? error).slice(0, 200) } };
      }
      const raw = { status: res.status, body: res.body, bytes: res.bytes, contentType: res.contentType };
      const projected = opts.project ? opts.project(raw) : res.binary ? { contentType: res.contentType, bytes: res.bytes?.length > 0 } : res.body;
      if (res.status >= 500) console.log(`  ⚠ ${step} → HTTP ${res.status} ${JSON.stringify(res.body)?.slice(0, 300)}`);
      if (argv.includes("--verbose")) console.log(`  [${res.status}] ${step}  ${JSON.stringify(projected ?? null)?.slice(0, 300)}`);
      if (opts.silent) return { status: res.status, body: res.body, bytes: res.bytes, contentType: res.contentType }; // 輪詢這類次數隨宿主快慢而不同的呼叫不記成步驟
      log.push({ step, status: res.status, body: projected, unordered: !!opts.unordered });
      return { status: res.status, body: res.body, bytes: res.bytes, contentType: res.contentType };
    },
  };
  Object.assign(api, projections(names));
  return api;
}

const loaders = {
  node: () => import("./hosts/node.mjs"),
  desktop: () => import("./hosts/desktop.mjs"),
  browser: () => import("./hosts/browser.mjs"),
};

const results = [];
for (const hostName of wanted) {
  if (!loaders[hostName]) { console.error(`不認得的宿主：${hostName}（node、desktop、browser）`); process.exit(2); }
  const started = Date.now();
  let host;
  const entry = { host: hostName, label: hostName, notes: [], error: null, normalized: null, skipped: null };
  try {
    host = await (await loaders[hostName]()).startHost({ repo: REPO, argv, flag });
    entry.label = host.label;
    entry.notes = host.notes ?? [];
    if (host.skipped) { entry.skipped = host.skipped; }
    else {
      const api = makeApi(host);
      try { await runScript(api); } catch (error) { entry.error = `劇本中斷：${error.message}`; }
      entry.normalized = normalizeLog(api.log, api.names);
      entry.raw = api.log.length;
    }
  } catch (error) {
    entry.error = `宿主啟動失敗：${String(error?.stack ?? error).split("\n").slice(0, 4).join(" | ")}`;
  } finally {
    await host?.close?.().catch(() => {});
  }
  entry.seconds = Math.round((Date.now() - started) / 1000);
  results.push(entry);
  console.log(`▸ ${entry.label}：${entry.skipped ? `略過（${entry.skipped}）` : entry.error ? `錯誤：${entry.error}` : `${entry.normalized.length} 步，${entry.seconds} 秒`}`);
  for (const n of entry.notes) console.log(`    ${n}`);
}

const outDir = join(REPO, "packages/frontend/e2e/parity/.out");
mkdirSync(outDir, { recursive: true });
for (const r of results) if (r.normalized) writeFileSync(join(outDir, `${r.host}.json`), JSON.stringify(r.normalized, null, 2));

const known = loadKnownDifferences(REPO);
const report = compareHosts(results, known);
const code = summarize(report, results, known);
process.exit(code);

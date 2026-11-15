// 瀏覽器版測試台（Playwright）。
//   npm run bench:browser -- --browser chromium --throttle 4      # Chromium，CPU 降速 4 倍（模擬手機）
//   npm run bench:browser -- --browser webkit   --throttle 1      # WebKit（無法降速；業主筆電用 docker --cpus=0.7 補量，見 README）
// 選項：--only proto,dt  --quick  --ops a,b,c,t  --out out/browser-chromium-x4.json
import { build } from "esbuild";
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { forkScenarios } from "./cases.js";
import { TRACE_LIST, loadTrace } from "./traces.js";
import type { RunResult, Spec } from "./browserEntry.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const flag = (n: string) => args.includes(`--${n}`);
const browserName = opt("browser", "chromium") as "chromium" | "webkit" | "firefox";
const throttle = Number(opt("throttle", browserName === "chromium" ? "4" : "1"));
const only = opt("only", "diff3,ref,dt,proto").split(",");
const ops = opt("ops", "a,b,c,t").split(",");
const quick = flag("quick");
const caseFilter = opt("case", "");
const extraJsFlags = opt("js-flags", "");
const outFile = opt("out", join(root, "out", `browser-${browserName}-x${throttle}.json`));
const refNodeMs = (() => {
  // ref 在 Node 要超過 3 秒的情境，瀏覽器不再重跑（降速後會是數十秒到數分鐘）
  try { return JSON.parse(readFileSync(join(root, "out", "node.json"), "utf8")).rows as Array<{ case: string; op: string; impl: string; stats?: { medianMs: number } }>; } catch { return []; }
})();

async function prepareSite(): Promise<string> {
  const dir = join(root, "out", "site");
  mkdirSync(join(dir, "traces"), { recursive: true });
  mkdirSync(join(dir, "dt"), { recursive: true });
  await build({
    entryPoints: [join(here, "browserEntry.ts")], bundle: true, minify: true, format: "iife", target: "es2020",
    outfile: join(dir, "bundle.js"), logLevel: "silent", platform: "browser",
  });
  copyFileSync(join(root, "node_modules", "diamond-types-web", "dt_bg.wasm"), join(dir, "dt_bg.wasm"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>bench</title><script src="/bundle.js"></script>`);
  for (const m of TRACE_LIST) {
    const f = join(dir, "traces", `${m.id}.json`);
    if (!existsSync(f)) writeFileSync(f, JSON.stringify(loadTrace(m.id).history));
    copyFileSync(join(root, "data", m.dtFile), join(dir, "dt", m.dtFile));
  }
  return dir;
}

async function main() {
  const dir = await prepareSite();
  const server = createServer((req, res) => {
    const p = join(dir, decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+$/, "index.html"));
    try {
      const body = readFileSync(p.endsWith("/") ? join(p, "index.html") : p);
      const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".wasm") ? "application/wasm" : p.endsWith(".json") ? "application/json" : p.endsWith(".html") ? "text/html" : "application/octet-stream";
      res.writeHead(200, { "content-type": type }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const type = { chromium, webkit, firefox }[browserName];
  const browser = await type.launch(browserName === "chromium" ? { args: [`--js-flags=--expose-gc${extraJsFlags ? " " + extraJsFlags : ""}`, "--enable-precise-memory-info"] } : {});
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("頁面錯誤", e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench !== undefined);
  if (throttle !== 1) {
    if (browserName !== "chromium") throw new Error("只有 Chromium 支援 CPU 降速（CDP）；其他瀏覽器請用 --throttle 1 並以 docker --cpus 限制");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  const call = (spec: Spec) => page.evaluate((s) => (window as unknown as { __bench: { run(s: Spec): Promise<RunResult> } }).__bench.run(s), spec);
  const calibrationMs = await page.evaluate(() => (window as unknown as { __bench: { calibrate(): number } }).__bench.calibrate());
  const ua = await page.evaluate(() => navigator.userAgent);
  const env = { browser: browserName, version: browser.version(), ua, throttle, calibrationMs, date: new Date().toISOString() };
  console.log("環境", env);

  const rows: Array<Record<string, unknown>> = [];
  const doit = async (spec: Spec) => {
    if (!only.includes(spec.impl)) return;
    if (spec.impl === "ref") {
      if (spec.kind === "trace" && !["friendsforever", "clownschool"].includes(spec.id)) return;
      const n = refNodeMs.find((r) => r.case === spec.id && r.op === spec.op && r.impl === "ref");
      if (spec.kind === "fork" && n?.stats && n.stats.medianMs > 3000) { rows.push({ ...spec, skipped: "參考實作在 Node 已超過 3 秒，瀏覽器未重跑" }); return; }
    }
    if (spec.impl === "diff3" && spec.op === "b") return;
    const r = await call(spec);
    rows.push({ ...spec, ...r });
    console.log(`  ${spec.id} ${spec.op} ${spec.impl}: ${r.skipped ? "跳過 " + r.skipped : `中位數 ${r.stats!.medianMs.toFixed(2)} ms  p95 ${r.stats!.p95Ms.toFixed(2)} ms  n=${r.stats!.n}`}`);
  };
  for (const sc of forkScenarios(quick)) {
    if (caseFilter && !sc.id.includes(caseFilter)) continue;
    console.log(`情境 ${sc.id}`);
    for (const op of ["a", "b", "c"] as const) if (ops.includes(op)) for (const impl of ["diff3", "ref", "dt", "proto"] as const) await doit({ kind: "fork", id: sc.id, op, impl });
  }
  if (ops.includes("t")) for (const m of TRACE_LIST) {
    console.log(`trace ${m.id}`);
    for (const impl of ["ref", "dt", "proto"] as const) await doit({ kind: "trace", id: m.id, op: "b", impl, dtFile: m.dtFile });
  }
  // 冷啟動：每次重新載入頁面，量操作最前面三次（--cold N 次重載；預設不量）
  const cold: Array<Record<string, unknown>> = [];
  const coldN = Number(opt("cold", "0"));
  if (coldN > 0) {
    console.log(`冷啟動（每個 ${coldN} 次全新頁面）`);
    for (const id of ["200KB-100", "200KB-1000"]) for (const impl of ["diff3", "dt", "proto"] as const) {
      for (let k = 0; k < coldN; k++) {
        const pg = await browser.newPage();
        await pg.goto(`http://127.0.0.1:${port}/`);
        await pg.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench !== undefined);
        if (throttle !== 1) await (await pg.context().newCDPSession(pg)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
        const r = await pg.evaluate((s) => (window as unknown as { __bench: { runCold(s: Spec): Promise<unknown> } }).__bench.runCold(s), { kind: "fork", id, op: "a", impl } as Spec);
        cold.push({ id, impl, ...(r as object) });
        await pg.close();
      }
      const mine = cold.filter((c) => c.id === id && c.impl === impl) as Array<{ firstMs: number; secondMs: number; thirdMs: number }>;
      const med = (f: (c: { firstMs: number; secondMs: number; thirdMs: number }) => number) => mine.map(f).sort((a, b) => a - b)[mine.length >> 1]!;
      console.log(`  ${id} a ${impl}: 第 1 次 ${med((c) => c.firstMs).toFixed(1)} ms / 第 2 次 ${med((c) => c.secondMs).toFixed(1)} ms / 第 3 次 ${med((c) => c.thirdMs).toFixed(1)} ms（${mine.length} 頁中位數）`);
    }
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ env, rows, cold }, null, 1));
  console.log("寫入", outFile);
  await browser.close();
  server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

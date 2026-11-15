// `node scripts/bench/board-ink.mjs`: how smoothly the whiteboard's committed ink
// pans and pinch-zooms on a phone screen (Canvas 2D, tiled).
// Builds the board's own renderer through createCommittedRenderer (what
// CanvasInkLayer calls), seeds strokes, and records requestAnimationFrame gaps in
// headless Chromium at 390×844 with CPU throttling.
//
//   node scripts/bench/board-ink.mjs                              1k / 10k strokes, CPU ×4
//   node scripts/bench/board-ink.mjs --strokes=10000
//   node scripts/bench/board-ink.mjs --cpu=1,4 --dpr=2.75 --json=out.json
//
// A measuring tool, not a budget (not part of `bench:check`). The bar the board met when
// it moved from Pixi to Canvas 2D (#1241): 10k strokes, CPU ×4, pan p95 ≤ 20 ms.
import { build } from "vite";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { repoRoot } from "../lib/paths.mjs";

const root = repoRoot;
const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const strokeCounts = option("strokes", "1000,10000").split(",").map(Number);
const renderers = ["canvas2d"];
const cpuRates = option("cpu", "4").split(",").map(Number);
const dpr = Number(option("dpr", "2.75")); // Pixel 5
const frames = Number(option("frames", "180"));
const jsonOut = option("json");
const SEED = 20261102;

const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const from of [resolve(root, "packages/frontend/e2e/"), root, "/opt/node-tools"]) {
    try { return require(require.resolve("playwright", { paths: [from] })); } catch { /* next */ }
  }
  throw new Error("playwright not found (npm i in packages/frontend/e2e, or install it globally)");
})();

function markdownAlias() {
  const pkgDir = resolve(root, "packages/markdown");
  const exportsMap = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")).exports;
  const alias = {};
  for (const [sub, target] of Object.entries(exportsMap)) {
    const types = typeof target === "string" ? target : target.types;
    alias[sub === "." ? "@onden/markdown" : `@onden/markdown/${sub.slice(2)}`] = resolve(pkgDir, types);
  }
  return alias;
}

const outDir = resolve(root, ".bench/board-ink");
mkdirSync(outDir, { recursive: true });
// An ES-module build (not iife): the Pixi renderer is a dynamic import and becomes its own chunk.
await build({
  root,
  configFile: false,
  logLevel: "error",
  resolve: {
    alias: Object.entries(markdownAlias()).sort((a, b) => b[0].length - a[0].length).map(([find, replacement]) => ({ find, replacement })),
  },
  esbuild: { jsx: "automatic" },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir,
    emptyOutDir: true,
    minify: true,
    rollupOptions: { input: resolve(root, "scripts/bench/board-ink/entry.tsx"), output: { entryFileNames: "bundle.js", chunkFileNames: "[name].js" } },
  },
});
writeFileSync(resolve(outDir, "index.html"), '<!doctype html><meta charset="utf-8"><body></body><script type="module" src="bundle.js"></script>');

// Module scripts do not load from file://, so serve the build over http.
const TYPES = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer(async (req, res) => {
  const name = req.url === "/" ? "index.html" : req.url.slice(1);
  try {
    const body = await readFile(resolve(outDir, name));
    res.writeHead(200, { "content-type": TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

const stats = (gaps) => {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { frames: gaps.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0, over34: gaps.filter((g) => g > 34).length };
};

const RECORDER = `
  window.__rec = (() => {
    const gaps = []; let last = 0, live = true;
    const tick = (t) => { if (!live) return; if (last) gaps.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { stop() { live = false; return gaps; } };
  })();`;

async function measure(browser, kind, count, cpu) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(baseUrl);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const opened = await page.evaluate(([k, n, seed]) => window.__boardBench.mount(k, n, seed), [kind, count, SEED]);
  const record = async (action) => {
    await page.evaluate(RECORDER);
    await action();
    return stats((await page.evaluate(() => window.__rec.stop())).slice(2));
  };
  const pan = await record(() => page.evaluate((n) => window.__boardBench.pan(n, 6), frames));
  const pinch = await record(() => page.evaluate((n) => window.__boardBench.pinch(n), frames));
  const settleWorstMs = await page.evaluate(() => window.__boardBench.settleRepaint());
  await context.close();
  return { renderer: opened.kind, strokes: count, cpu, createMs: opened.createMs, commitMs: opened.commitMs, heapMB: opened.heapMB, pan, pinch, settleWorstMs };
}

const browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = [];
const f = (n) => n.toFixed(1);
for (const count of strokeCounts) {
  for (const cpu of cpuRates) {
    for (const kind of renderers) {
      const r = await measure(browser, kind, count, cpu);
      results.push(r);
      console.log(`${String(count).padStart(6)} ${r.renderer.padEnd(8)} cpu×${cpu}  commit ${f(r.commitMs)} ms  heap ${f(r.heapMB)} MB`
        + `  | pan p50 ${f(r.pan.p50)} p95 ${f(r.pan.p95)} >34ms ${r.pan.over34}/${r.pan.frames}`
        + `  | pinch p50 ${f(r.pinch.p50)} p95 ${f(r.pinch.p95)} >34ms ${r.pinch.over34}/${r.pinch.frames}`
        + `  | settle worst frame ${f(r.settleWorstMs)} ms`);
    }
  }
}
await browser.close();
server.close();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ dpr, seed: SEED, results }, null, 2));

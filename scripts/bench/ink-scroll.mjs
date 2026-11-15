// `node scripts/bench/ink-scroll.mjs`: how smoothly the handwriting page scrolls,
// writes and zooms when it holds a lot of ink. Mounts the real InkNodeView with
// seeded fake strokes in headless Chromium and records requestAnimationFrame gaps.
//
//   node scripts/bench/ink-scroll.mjs                          2k / 10k / 30k strokes, CPU ×1 and ×4
//   node scripts/bench/ink-scroll.mjs --strokes=10000 --cpu=4  one cell
//   node scripts/bench/ink-scroll.mjs --dpr=2 --json=out.json  tablet-like pixel ratio, save numbers
//
// A measuring tool, not a budget: it is not part of `bench:check`. Needs
// Playwright (the one in packages/frontend/e2e or any installed `playwright`).
import { build } from "vite";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../lib/paths.mjs";

const root = repoRoot;
const args = process.argv.slice(2);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const strokeCounts = option("strokes", "2000,10000,30000").split(",").map(Number);
const cpuRates = option("cpu", "1,4").split(",").map(Number);
const dpr = Number(option("dpr", "2"));
const frames = Number(option("frames", "240"));
const jsonOut = option("json");
const SEED = 20261030;

const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const from of [resolve(root, "packages/frontend/e2e/"), root, "/opt/node-tools"]) {
    try { return require(require.resolve("playwright", { paths: [from] })); } catch { /* next */ }
  }
  throw new Error("playwright not found (npm i in packages/frontend/e2e, or install it globally)");
})();

// @onden/markdown subpaths → source files, from its package.json exports (same idea as frontend/astro.config.mjs).
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

const outDir = resolve(root, ".bench/ink-scroll");
mkdirSync(outDir, { recursive: true });
// Vite (not esbuild alone): esbuild matches file names case-insensitively and trips on
// tasks/quickAddTask.ts next to tasks/QuickAddTask.tsx, which this import chain reaches.
await build({
  root,
  configFile: false,
  logLevel: "error",
  resolve: {
    alias: [
      ...Object.entries(markdownAlias()).sort((a, b) => b[0].length - a[0].length).map(([find, replacement]) => ({ find, replacement })),
      // @onden/site's root entry is dist/ in its package.json; read the source, as frontend/astro.config.mjs does.
      { find: /^@onden\/site$/, replacement: resolve(root, "packages/site/src/index.ts") },
    ],
  },
  esbuild: { jsx: "automatic" },
  define: { "process.env.NODE_ENV": '"production"', __ONDEN_BUILD_ID__: '"bench"' },
  build: {
    outDir,
    emptyOutDir: true,
    minify: true,
    cssCodeSplit: false,
    lib: { entry: resolve(root, "scripts/bench/ink-scroll/entry.tsx"), formats: ["iife"], name: "InkBench", fileName: () => "bundle.js" },
    rollupOptions: { output: { assetFileNames: "bundle[extname]" } },
  },
});
writeFileSync(resolve(outDir, "index.html"),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><body></body><script src="bundle.js"></script>');

const stats = (gaps) => {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { frames: gaps.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0, over34: gaps.filter((g) => g > 34).length };
};

/** In-page: record gaps between animation frames until `stop()`; also the longest long task. */
const RECORDER = `
  window.__rec = (() => {
    const gaps = []; let last = 0, live = true, longest = 0;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
    try { po.observe({ entryTypes: ["longtask"] }); } catch {}
    const tick = (t) => { if (!live) return; if (last) gaps.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { stop() { live = false; po.disconnect(); return { gaps, longest }; } };
  })();`;

async function measure(browser, count, cpu) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(resolve(outDir, "index.html")).href);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });

  const openMs = await page.evaluate(async ([n, seed]) => {
    const t0 = performance.now();
    window.__inkBench.mount(n, seed);
    while (!document.querySelector(".page-ink-surface")) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  }, [count, SEED]);

  const record = async (action) => {
    await page.evaluate(RECORDER);
    await action();
    const { gaps, longest } = await page.evaluate(() => window.__rec.stop());
    return { ...stats(gaps.slice(2)), longTaskMax: longest };
  };

  // Scroll 240 frames: one wheel step per animation frame, 24 px each.
  const scroll = await record(() => page.evaluate(async (n) => {
    const scroller = document.querySelector(".pagebook-scroll");
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      scroller.scrollTop += 24;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }, frames));

  // Write six strokes with the mouse near the top of the page.
  const box = await page.locator(".page-ink-surface").boundingBox();
  const write = await record(async () => {
    for (let s = 0; s < 6; s++) {
      const x = box.x + 120 + s * 60, y = box.y + 120;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let k = 1; k <= 40; k++) {
        await page.mouse.move(x + k * 2, y + Math.sin(k / 4) * 20);
      }
      await page.mouse.up();
    }
  });

  // ctrl + wheel zoom in and out.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  const zoom = await record(async () => {
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, i < 20 ? -40 : 40); }
    await page.waitForTimeout(400);
  });
  await page.keyboard.up("Control");

  await context.close();
  return { strokes: count, cpu, openMs, scroll, write, zoom };
}

const browser = await chromium.launch();
const results = [];
for (const count of strokeCounts) {
  for (const cpu of cpuRates) {
    const r = await measure(browser, count, cpu);
    results.push(r);
    const f = (n) => n.toFixed(1);
    console.log(`${String(count).padStart(6)} strokes  cpu×${cpu}  open ${f(r.openMs)} ms`
      + `  | scroll p50 ${f(r.scroll.p50)} p95 ${f(r.scroll.p95)} >34ms ${r.scroll.over34}/${r.scroll.frames}`
      + `  | write p95 ${f(r.write.p95)} long task ${f(r.write.longTaskMax)}`
      + `  | zoom p95 ${f(r.zoom.p95)} >34ms ${r.zoom.over34}/${r.zoom.frames}`);
  }
}
await browser.close();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ dpr, seed: SEED, results }, null, 2));

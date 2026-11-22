#!/usr/bin/env node
// Style census: every screen × width × theme, the COMPUTED look measured per kind of value (see docs/agents/appearance-rules.md),
// classified against scale.mjs, next to the STATIC counts from the sources. Manual, like layout:audit: not part of tests or CI.
//   npm run build:browser                           # root; the census reads dist-browser
//   npm run style:census                            # in packages/frontend: all screens × 4 sizes × 2 themes
//   npm run style:census -- --sizes 390,1440 --themes light --screens note-long,daily --jobs 2
//   npm run style:census -- --sheets <dir>          # also one PNG per screen × size × theme, an index.md and one montage per size × theme
// Writes e2e/style-census/report.json and docs/research/style-census-<date>.md (--date, default today).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, startSite, openApp, installHelpers } from "../layout-audit/env.mjs";
import { SCREENS, Skip } from "../layout-audit/screens.mjs";
import { seedCensusData } from "../layout-audit/seed.mjs";
import { CENSUS_SOURCE } from "./collect.mjs";
import { COMBOS } from "./viewports.mjs";
import { AI_STAND_IN } from "./aiStandIn.mjs";
import { KIND_IDS, classify, A_TOKENS_KEPT } from "./scale.mjs";
import { scanCss, scanTsx, sourceOfRule } from "./static.mjs";
import { renderReport } from "./report.mjs";
import { writeSheets } from "./sheets.mjs";
import { compareReports, renderComparison, summarize } from "./compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const list = (name) => arg(name)?.split(",").filter(Boolean) ?? null;
const combos = COMBOS.filter((c) => (!list("--sizes") || list("--sizes").includes(c.size)) && (!list("--themes") || list("--themes").includes(c.theme)));
const screens = SCREENS.filter((s) => !list("--screens") || list("--screens").includes(s.id));
const jobs = Number(arg("--jobs") ?? 3);
// --compare <older report.json>: fail when an off-scale count grew. With --against <newer report.json> it only compares the two files.
const compareWith = arg("--compare");
const readReport = (file) => JSON.parse(readFileSync(resolve(file), "utf8"));
const finishCompare = (newer) => {
  const result = compareReports(readReport(compareWith), newer);
  console.log(renderComparison(result));
  return result.ok ? 0 : 1;
};
if (compareWith && arg("--against")) process.exit(finishCompare(readReport(arg("--against"))));
const sheetsDir = arg("--sheets");
const date = arg("--date") ?? new Date().toISOString().slice(0, 10);
const t0 = Date.now();
process.env.AUDIT_CLICK_TIMEOUT_MS ??= "6000"; // a button that is not there after 6 s is not coming: the screen is reported as unreachable

const css = scanCss();
const tsx = scanTsx();
const site = await startSite(arg("--dir") ?? "dist-browser");
const browser = await launch();

// Peak memory: this process plus every Chromium process, sampled (the browser is where the memory goes).
let peakChromeKb = 0;
const sample = () => { try { const kb = execFileSync("ps", ["-eo", "rss,comm"], { encoding: "utf8" }).split("\n").filter((l) => /chrom/i.test(l)).reduce((a, l) => a + (Number(l.trim().split(/\s+/)[0]) || 0), 0); peakChromeKb = Math.max(peakChromeKb, kb); } catch {} };
const sampler = setInterval(sample, 5000);

// ── what is collected ──
const agg = {};           // kind → value → { n, screens:Set, ex:[{sel,prop,source}], on, why }
const places = new Map(); // key → { sel, off:Set(kinds), offN, screens:Set, sources:Set }
const byScreen = {};      // screen → kind → { total, off }
const bySource = {};      // file → kind → off count
const status = [];        // screen × combo → ok | skip | error
const failures = [];
const taps = {};          // size → screen → { total, off }; and the smallest controls
const tapSmall = {};      // size → [{ sel, screen, drawn, hit, min }]
const resolutionStats = { exact: 0, approx: 0, inline: 0, none: 0 };

for (const k of KIND_IDS) agg[k] = {};

function sourceLabel(src) {
  if (!src) { resolutionStats.none++; return null; }
  if (src.inline) { resolutionStats.inline++; return { file: "(行內 style／TSX)", line: 0 }; }
  const hit = sourceOfRule(css, src.sel);
  if (!hit) { resolutionStats.none++; return { file: `(找不到：${src.sheet})`, line: 0, sel: src.sel.slice(0, 60) }; }
  resolutionStats[hit.exact ? "exact" : "approx"]++;
  return { file: hit.file, line: hit.line, exact: hit.exact };
}

async function censusScreen(page, combo, screen) {
  await installHelpers(page);
  await page.evaluate(CENSUS_SOURCE);
  const data = await page.evaluate((o) => window.__census.collect(o), { colourPriority: A_TOKENS_KEPT.colour });
  const ctx = { coarse: data.coarse };
  const where = `${screen.id}@${combo.id}`;
  const offKeys = new Map(); // key → Set(props) of off-scale values
  const stat = (byScreen[screen.id] ||= {});
  for (const [key, rec] of Object.entries(data.keys)) {
    for (const [kind, vals] of Object.entries(rec.kinds)) {
      for (const [value, n] of Object.entries(vals)) {
        const c = classify(kind, value, ctx);
        const s = ((stat[kind] ||= { total: 0, off: 0 }));
        s.total += n; if (!c.on) s.off += n;
        if (!c.on) {
          const props = rec.props[`${kind}|${value}`] ?? [];
          if (!offKeys.has(key)) offKeys.set(key, new Set());
          props.forEach((p) => offKeys.get(key).add(p));
          const pl = places.get(key) ?? { sel: rec.sel, off: new Set(), offN: 0, screens: new Set(), sources: new Set(), values: {} };
          pl.off.add(kind); pl.offN += n; pl.screens.add(screen.id); pl.values[kind] = value; places.set(key, pl);
        }
      }
    }
  }
  // Source of what is off: one lookup per key and property, cached in the page.
  const requests = [...offKeys].map(([key, props]) => ({ key, props: [...props] }));
  const resolved = requests.length ? await page.evaluate((r) => window.__census.resolve(r), requests) : {};
  const srcOf = (key, prop) => sourceLabel(resolved[key]?.[prop]);
  for (const [kind, vals] of Object.entries(data.values)) {
    for (const [value, rec] of Object.entries(vals)) {
      const c = classify(kind, value, ctx);
      const e = (agg[kind][value] ||= { n: 0, nOff: 0, screens: new Set(), ex: [], why: null, to: null });
      e.n += rec.n; e.screens.add(where);
      // The same value can be on the scale on one screen type and off on another (44 is right on a touch screen, wrong with a mouse): count the off part.
      if (!c.on) { e.nOff += rec.n; e.why ??= c.why; e.to ??= c.to ?? null; }
      for (const x of rec.ex) if (e.ex.length < 3 && !e.ex.some((y) => y.key === x.key)) e.ex.push({ ...x, source: resolved[x.key]?.[x.prop] ? srcOf(x.key, x.prop) : null, where });
    }
  }
  for (const [key, props] of offKeys) {
    const pl = places.get(key);
    for (const p of props) { const s = srcOf(key, p); if (s) pl.sources.add(s.file); }
  }
  // Attribute off counts to source files.
  for (const [key, rec] of Object.entries(data.keys)) {
    for (const [kind, vals] of Object.entries(rec.kinds)) for (const [value, n] of Object.entries(vals)) {
      if (classify(kind, value, ctx).on) continue;
      const props = rec.props[`${kind}|${value}`] ?? [];
      const s = props.map((p) => srcOf(key, p)).find(Boolean);
      const file = s?.file ?? "(未解析)";
      ((bySource[file] ||= {})[kind] ||= 0); bySource[file][kind] += n;
    }
  }
  if (data.coarse && combo.theme === "light") { // light only: the dark theme has the same boxes, and counting both would double the numbers
    const t = ((taps[combo.size] ||= {})[screen.id] ||= { total: 0, off: 0 });
    for (const x of data.taps) {
      t.total++; if (x.min < 43.5) { t.off++; (tapSmall[combo.size] ||= []).push({ ...x, screen: screen.id }); }
    }
  }
  // Focus ring: Tab to the first three things that can take focus.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => window.__census.focusRing());
    if (!f) continue;
    const c = classify("focus-ring", f.value, ctx);
    const e = (agg["focus-ring"][f.value] ||= { n: 0, nOff: 0, screens: new Set(), ex: [], why: c.why ?? null, to: null });
    e.n++; e.screens.add(where); if (!c.on) e.nOff++;
    if (e.ex.length < 3 && !e.ex.some((y) => y.key === f.key)) e.ex.push({ sel: f.sel, prop: "outline", key: f.key, source: null, where });
    const s = (stat["focus-ring"] ||= { total: 0, off: 0 }); s.total++; if (!c.on) s.off++;
  }
  return data.elements;
}

const shots = []; // { screen, size, theme, file }
async function runCombo(combo) {
  const seeded = await openApp(browser, site, combo, { extraSeed: seedCensusData, beforeLoad: (ctx) => ctx.addInitScript(AI_STAND_IN) });
  let empty = null;
  const getEmpty = async () => {
    if (empty) return empty;
    empty = await openApp(browser, site, combo, { seed: false });
    await empty.page.evaluate(async () => { await fetch("/api/browser-app/clear-samples", { method: "POST" }); });
    await empty.page.waitForTimeout(800);
    return empty;
  };
  const phone = !!combo.mobile || combo.width <= 900;
  for (const screen of screens) {
    const row = { screen: screen.id, name: screen.name, combo: combo.id, state: "ok" };
    status.push(row);
    const tScreen = Date.now();
    const done = () => { if (process.env.CENSUS_VERBOSE) console.log(`    ${combo.id} ${screen.id}: ${row.state} ${Math.round((Date.now() - tScreen) / 1000)}s ${row.why ?? ""}`); };
    const env = screen.empty ? await getEmpty() : seeded;
    const h = { page: env.page, site, vp: combo, phone };
    try { await screen.go(h); }
    catch (e) {
      if (e instanceof Skip) { row.state = "skip"; row.why = e.message; continue; }
      row.state = "error"; row.why = String(e.message).split("\n")[0].slice(0, 160); failures.push(`${screen.id} @ ${combo.id}：${row.why}`); await screen.after?.(h).catch(() => {}); continue;
    }
    try {
      if (sheetsDir) {
        mkdirSync(sheetsDir, { recursive: true });
        const file = `${screen.id}__${combo.size}__${combo.theme}.png`;
        await env.page.screenshot({ path: join(sheetsDir, file), scale: "css" });
        shots.push({ screen: screen.id, name: screen.name, size: combo.size, theme: combo.theme, file });
      }
      row.elements = await censusScreen(env.page, combo, screen);
    } catch (e) { row.state = "error"; row.why = String(e.message).split("\n")[0].slice(0, 160); failures.push(`${screen.id} @ ${combo.id}（量測）：${row.why}`); }
    await screen.after?.(h).catch(() => {});
    done();
  }
  if (seeded.errors.length) failures.push(`頁面有腳本錯誤 @ ${combo.id}：${seeded.errors[0]}`);
  await seeded.context.close(); await empty?.context.close();
}

const queue = [...combos];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const combo = queue.shift(); const t = Date.now();
    try { await runCombo(combo); console.log(`  ${combo.label} ${combo.theme}：完成（${Math.round((Date.now() - t) / 1000)} 秒）`); }
    catch (e) { failures.push(`${combo.id} 整個失敗：${String(e.message).split("\n")[0]}`); console.log(`  ${combo.id} 失敗：${e.message.split("\n")[0]}`); }
  }
}));
clearInterval(sampler); sample();
await browser.close(); site.close();

// ── the report ──
const elapsedSec = Math.round((Date.now() - t0) / 1000);
const report = {
  date, combos: combos.map((c) => c.id), screens: screens.map((s) => ({ id: s.id, name: s.name, census: !!s.census })),
  cost: { seconds: elapsedSec, jobs, nodeMaxRssMb: Math.round(process.resourceUsage().maxRSS / 1024), chromePeakRssMb: Math.round(peakChromeKb / 1024) },
  resolution: resolutionStats, failures, status,
  kinds: Object.fromEntries(KIND_IDS.map((kind) => {
    const vals = Object.entries(agg[kind]).map(([value, e]) => ({ value, n: e.n, nOff: e.nOff, why: e.why, to: e.to, screens: e.screens.size, screenList: [...e.screens].slice(0, 8), examples: e.ex }))
      .sort((a, b) => b.n - a.n);
    return [kind, { total: vals.reduce((a, v) => a + v.n, 0), distinct: vals.length, off: vals.reduce((a, v) => a + v.nOff, 0), offDistinct: vals.filter((v) => v.nOff > 0).length, values: vals }];
  })),
  byScreen, bySource, taps,
  tapSmallest: Object.fromEntries(Object.entries(tapSmall).map(([size, l]) => { const g = new Map(); for (const x of l) { const k = x.sel; const e = g.get(k) ?? { ...x, n: 0, screens: new Set() }; e.n++; e.screens.add(x.screen); g.set(k, e); } return [size, [...g.values()].sort((a, b) => a.min - b.min || b.n - a.n).slice(0, 25).map((e) => ({ sel: e.sel, drawn: e.drawn, hit: e.hit, min: e.min, n: e.n, screens: [...e.screens].slice(0, 5) }))]; })),
  places: [...places.entries()].map(([key, p]) => ({ key, sel: p.sel, kindsOff: [...p.off], offN: p.offN, screens: [...p.screens], sources: [...p.sources], values: p.values }))
    .sort((a, b) => b.kindsOff.length - a.kindsOff.length || b.offN - a.offN).slice(0, 20),
  summary: null,
  static: { css: { declarations: css.declarations, kinds: css.kinds, media: css.media, mediaOther: css.mediaOther }, tsx },
};
report.summary = summarize(report);
writeFileSync(join(here, "report.json"), JSON.stringify(report, null, 1));
const docDir = resolve(here, "../../../../docs/research");
writeFileSync(join(docDir, `style-census-${date}.md`), renderReport(report));
if (sheetsDir) await writeSheets(sheetsDir, shots, status, combos);

const bad = status.filter((r) => r.state === "error").length, skipped = status.filter((r) => r.state === "skip").length;
console.log(`\n普查完成：${combos.length} 個寬度×主題 × ${screens.length} 個畫面；量到 ${status.filter((r) => r.state === "ok").length} 個，略過 ${skipped}，出錯 ${bad}；耗時 ${elapsedSec} 秒`);
for (const f of failures.slice(0, 40)) console.log("  " + f);
const compared = compareWith ? finishCompare(report) : 0;
process.exit(compared || (failures.length && !arg("--allow-failures") ? 1 : 0));

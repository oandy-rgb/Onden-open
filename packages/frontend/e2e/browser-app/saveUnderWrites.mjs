#!/usr/bin/env node
// Manual measurement (not part of run-all): does the browser app still save a copy while writes keep coming, and how
// long does a reopen take with a long journal? docs/architecture/browser-app.md §4, §12.2.
//   node e2e/browser-app/saveUnderWrites.mjs <serial|burst|typing|reopen> [--seconds 60] [--dir dist-browser] [--notes 300]
//   serial : one POST /api/nodes after another, no pause        (a script that never stops)
//   burst  : --lanes (default 20) requests always outstanding                      (a script that does not wait for answers)
//   typing : PATCH the same note every 1–3 s, a new note now and then (a person typing)
//   grow   : create notes up to --notes (default 300), timing 20 creations (median ms) at 10/500/1000/5000 notes and a POST /api/sync
//   reopen : plant --notes journal entries (a long session that never saved), reload, time "opening"
// Prints one line per 2 s: seconds, notes written, seconds since the last saved copy, unsaved, journal entries.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const mode = process.argv[2];
const seconds = Number(arg("--seconds", 60));
const notes = Number(arg("--notes", 300));
const site = await serve(resolve(here, "../..", arg("--dir", "dist-browser")));
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...playwright.devices["Desktop Chrome"], locale: "zh-TW" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(site.base);
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const up = (p) => until(() => p.evaluate(async () => { try { return (await fetch("/api/browser-app/state")).ok; } catch { return false; } }), 90_000);
if (!(await up(page))) { console.log("worker did not start"); process.exit(1); }
const state = () => page.evaluate(async () => (await fetch("/api/browser-app/state")).json());
const journalLength = () => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open("onden-browser-journal");
  open.onsuccess = () => { const c = open.result.transaction("entries").objectStore("entries").count(); c.onsuccess = () => { open.result.close(); resolve(c.result); }; };
  open.onerror = () => resolve(-1);
}));
// Let the first-open copy land so every run starts from "saved".
await until(async () => !(await state()).unsaved, 30_000);

let written = 0;
let stop = false;
const t0 = Date.now();
const post = (title) => page.evaluate(async (t) => { const r = await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t, markdown: "x" }) }); return r.ok ? (await r.json()).id : null; }, title);
const patch = (id, text) => page.evaluate(async ({ id, text }) => (await fetch(`/api/nodes/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: text }) })).status, { id, text });

async function load() {
  if (mode === "serial") { while (!stop) { await post(`s ${written}`); written++; } }
  else if (mode === "burst") {
    const lane = async () => { while (!stop) { await post(`b ${written}`); written++; } };
    await Promise.all(Array.from({ length: Number(arg("--lanes", 20)) }, lane));
  } else if (mode === "typing") {
    let id = await post("typing");
    let text = "";
    while (!stop) {
      text += "字";
      await patch(id, text); written++;
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
      if (Math.random() < 0.15) id = await post(`t ${written}`);
    }
  }
}

if (mode === "grow") {
  const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
  const timed = (fn) => page.evaluate(async (src) => { const t = performance.now(); await (0, eval)(`(${src})`)(); return performance.now() - t; }, fn.toString());
  let count = 0;
  for (const mark of [10, 500, 1000, 5000]) {
    if (mark > notes) break;
    await page.evaluate(async ({ from, to }) => { for (let i = from; i < to; i++) await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `g ${i}`, markdown: "hello world" }) }); }, { from: count, to: mark });
    count = mark; console.log("filled", mark);
    await until(async () => !(await state()).unsaved, 60_000);
    const creates = [], syncs = [];
    for (let i = 0; i < 20; i++) {
      creates.push(await page.evaluate(async (i) => { const t = performance.now(); await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `probe ${i}`, markdown: "hello world" }) }); return performance.now() - t; }, i));
      syncs.push(await page.evaluate(async () => { const t = performance.now(); await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ since: 0 }) }); return performance.now() - t; }));
    }
    count += 20;
    console.log(`GROW ${mark} notes: create median ${median(creates).toFixed(0)} ms, POST /api/sync median ${median(syncs).toFixed(0)} ms`);
  }
} else if (mode === "reopen") {
  // Plant `notes` journal entries (what a long session that never saved would have left), reload, time the opening.
  await page.evaluate((count) => new Promise((resolve, reject) => {
    const open = indexedDB.open("onden-browser-journal");
    open.onsuccess = () => {
      const tx = open.result.transaction("entries", "readwrite");
      const body = (i) => new TextEncoder().encode(JSON.stringify({ title: `planted ${i}`, markdown: "x" })).buffer;
      for (let i = 0; i < count; i++) tx.objectStore("entries").put({ seq: 1_000_000 + i, method: "POST", path: "/api/nodes", headers: [["content-type", "application/json"]], body: body(i) });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), notes);
  console.log(`planted ${notes} journal entries`);
  const reloaded = Date.now();
  await page.reload();
  await up(page);
  const seconds = (Date.now() - reloaded) / 1000;
  console.log(`RESULT reopen with ${notes} entries: ${seconds.toFixed(1)} s (${((seconds * 1000) / notes).toFixed(0)} ms per entry)`);
  const after = await state();
  console.log(JSON.stringify({ unsaved: after.unsaved, journal: await journalLength() }));
} else {
  const loadDone = load();
  const lastAt = (await state()).lastSavedAt;
  let saves = 0, lastSeen = lastAt, worst = 0, sinceMax = 0;
  while (Date.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await state();
    if (s.lastSavedAt !== lastSeen) { saves++; lastSeen = s.lastSavedAt; }
    const age = (Date.now() - (s.lastSavedAt ?? t0)) / 1000;
    worst = Math.max(worst, age);
    console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  written ${String(written).padStart(5)}  since last copy ${age.toFixed(1).padStart(5)} s  unsaved ${s.unsaved}  journal ${await journalLength()}  failed ${s.failed}  lastCopyMs ${s.lastCopyMs}`);
  }
  stop = true;
  await loadDone;
  console.log(`RESULT ${mode}: ${seconds} s, ${written} writes, ${saves} copies seen, longest gap since a copy ${worst.toFixed(1)} s`);
}
if (errors.length) console.log("page errors:", errors);
await browser.close();
site.close();

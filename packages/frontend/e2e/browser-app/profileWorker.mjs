#!/usr/bin/env node
// Manual measurement: where does the worker spend its time creating a note once there are N notes?
//   node e2e/browser-app/profileWorker.mjs [--notes 500] [--creates 20] [--dir dist-browser]
// Fills the workspace with --notes notes, then records a CPU profile of the worker (Chrome DevTools Protocol) while
// --creates notes are created one after another, and prints the functions with the most self time.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const notes = Number(arg("--notes", 500));
const creates = Number(arg("--creates", 20));
const site = await serve(resolve(here, "../..", arg("--dir", "dist-browser")));
const browser = await playwright.chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(site.base);
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
await until(() => page.evaluate(async () => { try { return (await fetch("/api/browser-app/state")).ok; } catch { return false; } }), 90_000);
await page.evaluate(async (n) => { for (let i = 0; i < n; i++) await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `fill ${i}`, markdown: "hello world" }) }); }, notes);
await until(() => page.evaluate(async () => !(await (await fetch("/api/browser-app/state")).json()).unsaved), 60_000);

const cdp = await browser.newBrowserCDPSession();
const targets = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "worker" && /worker\.js/.test(t.url));
if (!targets.length) { console.log("no worker target"); process.exit(1); }
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: targets[0].targetId, flatten: false });
const waiting = new Map();
let seq = 0;
cdp.on("Target.receivedMessageFromTarget", ({ message }) => { const m = JSON.parse(message); waiting.get(m.id)?.(m.result); });
const call = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }); });
await call("Profiler.enable");
await call("Profiler.setSamplingInterval", { interval: 200 });
await call("Profiler.start");
const times = [];
for (let i = 0; i < creates; i++) times.push(await page.evaluate(async (i) => { const t = performance.now(); await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `probe ${i}`, markdown: "hello world" }) }); return performance.now() - t; }, i));
const { profile } = await call("Profiler.stop");
times.sort((a, b) => a - b);
console.log(`${notes} notes: create median ${times[times.length >> 1].toFixed(0)} ms over ${creates}`);
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => { const n = byId.get(id); const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0)); });
const total = [...self.values()].reduce((a, b) => a + b, 0);
for (const [key, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${(us / 1000).toFixed(0).padStart(6)} ms  ${((us / total) * 100).toFixed(0).padStart(3)}%  ${key}`);
await browser.close();
site.close();

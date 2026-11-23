#!/usr/bin/env node
// The probe's own tests: its judgments must catch the failures it exists for (each case has a counter-example).
//   node e2e/probe/selftest.mjs        (npm run probe:prod:selftest; CI: scheduled-probe job)
// Runs a real Chromium on a local static page that flashes English before Chinese, and runs the probe script itself
// without secrets. No network, no site.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { englishUiStrings, partitionResults, sampleBoot, scrub, serverProbeSkipReason } from "./probeLib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
let bad = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) bad++; };

// English detection
check("an English sentence is caught", englishUiStrings(["Checking your workspace…"]).length === 1);
check("an English button label is caught", englishUiStrings(["Sign out"]).length === 1);
check("Chinese is not", englishUiStrings(["正在確認工作區資料…", "歡迎來到 Onden 試用版"]).length === 0);
check("product and format names are allowed", englishUiStrings(["匯出 PDF 與 Markdown", "Onden"]).length === 0);
check("an address is not a word", englishUiStrings(["https://onden.o-andy.com/app"]).length === 0);

// the secrets rule
check("no secrets → skip, naming what is missing", /略過：巡檢帳號未設定/.test(serverProbeSkipReason({}) ?? ""));
check("one secret missing → still skip", serverProbeSkipReason({ ONDEN_PROBE_URL: "x", ONDEN_PROBE_EMAIL: "y" }) !== null);
check("all three set → run", serverProbeSkipReason({ ONDEN_PROBE_URL: "x", ONDEN_PROBE_EMAIL: "y", ONDEN_PROBE_PASSWORD: "z" }) === null);
const skipRun = execFileSync("node", [join(here, "prod-probe.mjs"), "--only", "server"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
check("the script itself prints the skip and exits 0 without secrets", /探針略過 略過：巡檢帳號未設定/.test(skipRun));

// baseline rule: known red does not fail, fresh red does, a passing known one is to be deleted
const split = partitionResults([{ id: "a", ok: false }, { id: "b", ok: false }, { id: "c", ok: true }], { a: "wip", c: "wip" });
check("a known red is not fresh", split.knownRed.map((r) => r.id).join() === "a");
check("an unlisted red is fresh", split.fresh.map((r) => r.id).join() === "b");
check("a listed check that passes is removable", split.removable.join() === "c");
check("secrets are masked in kept text", scrub("mail me@x.org pw hunter22", ["me@x.org", "hunter22"]) === "mail «已遮蔽» pw «已遮蔽»");

// the flash: a page that shows English for 500 ms, then Chinese. Sampling while it boots must see the English.
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset=utf-8><body><div id=a>Loading your workspace</div><script>setTimeout(()=>{document.getElementById('a').textContent='歡迎來到 Onden 試用版';document.title='ready'},${req.url.includes("clean") ? 0 : 500})</script>`);
});
await new Promise((ok) => server.listen(0, ok));
const base = `http://localhost:${server.address().port}`;
let browser;
try { browser = await playwright.chromium.launch(); } catch (e) { console.log(`FAIL  Chromium cannot start: ${String(e.message).split("\n")[0]}`); process.exit(1); }
for (const [path, flashes] of [["/", true], ["/clean", false]]) {
  const page = await browser.newPage({ locale: "zh-TW" });
  await page.goto(base + path, { waitUntil: "commit" });
  const seen = await sampleBoot(page, { done: async () => (await page.title()) === "ready", limitMs: 8_000, everyMs: 50 });
  const caught = englishUiStrings(seen.lines).length > 0;
  check(flashes ? "an English flash during boot is caught" : "a boot with no English is not flagged", caught === flashes && seen.doneAt !== null);
  await page.close();
}
// the gate text is seen, and a boot that never finishes times out (done stays false)
{
  const page = await browser.newPage();
  await page.setContent("<body>正在確認工作區資料…</body>");
  const seen = await sampleBoot(page, { done: async () => false, limitMs: 600, everyMs: 50 });
  check("the 「正在確認工作區資料」 gate is noticed", seen.gateSeen);
  check("a boot that never finishes reports no finish time", seen.doneAt === null);
  await page.close();
}
await browser.close();
server.close();
console.log(bad ? `FAILED: ${bad}` : "probe selftest passed");
process.exit(bad ? 1 : 0);

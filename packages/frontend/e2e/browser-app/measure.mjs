#!/usr/bin/env node
// What opening the browser app costs: bytes downloaded (gzip, as a static host would send them) and time to the
// first note on screen, on a first open and on a later one.   node e2e/browser-app/measure.mjs [--dir dist-browser]
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const dirFlag = process.argv.indexOf("--dir");
const root = resolve(here, "../..", dirFlag > 0 ? process.argv[dirFlag + 1] : "dist-browser");
const site = await serve(root);
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ locale: "zh-TW", viewport: { width: 1280, height: 800 } });

async function open(label) {
  const page = await context.newPage();
  const files = new Set();
  page.on("response", (response) => { const u = new URL(response.url()); if (u.origin === new URL(site.base).origin && response.status() === 200) files.add(u.pathname); });
  let worker = "";
  page.on("console", (m) => { if (m.text().startsWith("[browser-app]")) worker = m.text(); });
  const t0 = Date.now();
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ timeout: 120_000 });
  const ms = Date.now() - t0;
  const ready = await page.evaluate(() => performance.getEntriesByType("navigation")[0].toJSON());
  let raw = 0, gzip = 0;
  for (const path of files) {
    const bytes = readFileSync(join(root, path === "/" ? "index.html" : path));
    raw += bytes.length;
    gzip += /\.(gz|png|woff2)$/.test(path) ? bytes.length : gzipSync(bytes, { level: 9 }).length;
  }
  if (process.env.LIST) console.log([...files].map((p) => [p, gzipSync(readFileSync(join(root, p === "/" ? "index.html" : p))).length]).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([p, n]) => `   ${(n / 1024).toFixed(0).padStart(6)} KiB  ${p}`).join("\n"));
  console.log(`${label}: ${worker}\n   first note visible after ${ms} ms; ${files.size} files, ${(gzip / 1048576).toFixed(2)} MiB gzip (${(raw / 1048576).toFixed(1)} MiB raw)`);
  await page.close();
}
await open("first open (no saved copy)");
await new Promise((r) => setTimeout(r, 3000)); // let the first copy be written
await open("second open (saved copy)");
await browser.close();
site.close();

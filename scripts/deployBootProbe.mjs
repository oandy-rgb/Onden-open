#!/usr/bin/env node
// Browser boot check after a deploy (docs/agents/deploy.md, step 7): the page loads with no script error and the
// local-data worker starts as a module Worker. HTTP status alone once let a frontend whose worker threw at load go live.
//   node scripts/deployBootProbe.mjs <url> <localDbWorker-….js>
// The worker's name comes from the served build (scripts/deploy-vps.sh reads it); it is not in the page's own scripts.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [url, worker] = process.argv.slice(2);
if (!url || !/^localDbWorker-[\w-]+\.js$/.test(worker ?? "")) {
  console.error("usage: deployBootProbe.mjs <url> <localDbWorker-….js>");
  process.exit(2);
}
const require = createRequire(new URL("../packages/frontend/e2e/package.json", import.meta.url));
// This worktree's e2e install, else PLAYWRIGHT_LIB, else any other worktree of the repo that has one installed
// (a fresh worktree usually has none, and the probe should not fail the deploy for that).
const otherWorktrees = () => {
  try {
    return execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))
      .flatMap((dir) => [join(dir, "packages/frontend/e2e/node_modules"), join(dir, "node_modules")]);
  } catch { return []; }
};
const playwright = (() => {
  try { return require("playwright"); } catch { /* look elsewhere */ }
  const libs = [process.env.PLAYWRIGHT_LIB, "/opt/node-tools/node_modules", ...otherWorktrees()].filter(Boolean);
  const lib = libs.find((dir) => existsSync(join(dir, "playwright", "package.json")));
  if (!lib) { console.error("deployBootProbe: no playwright found (set PLAYWRIGHT_LIB)"); process.exit(2); }
  return require(join(lib, "playwright"));
})();

const browser = await playwright.chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
const response = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
const status = response?.status() ?? 0;
const text = (await page.locator("body").innerText()).trim().length;
const workerResult = await page.evaluate((src) => new Promise((done) => {
  const w = new Worker(src, { type: "module" });
  const timer = setTimeout(() => { w.terminate(); done("ok"); }, 4000);
  w.onerror = (e) => { clearTimeout(timer); done(`error: ${e.message || "worker error"}`); };
}), `/_astro/${worker}`);
await browser.close();

console.log(`page ${status}, ${text} characters of text; worker ${worker}: ${workerResult}; script errors: ${errors.length ? errors.join(" | ") : "none"}`);
process.exit(status === 200 && text > 0 && workerResult === "ok" && errors.length === 0 ? 0 : 1);

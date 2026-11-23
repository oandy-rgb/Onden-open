// npm run build:browser (repo root), then: node e2e/browser-app/localEditionNoGate.mjs [chromium|mobile-chrome] [--dir dist-browser]
// The local edition (the browser version: one person, no server, no members) has no sign-out and never locks the
// workspace behind 「正在確認工作區資料…」 (lib/hostCapabilities.ts). Owner report 2026-11-23: after pressing 登出 there,
// every reload went back to that screen within seconds and 「重新檢查」 never let them in.
// The state is made the way a test can make it: the device forgets its verified account (what sign-out does) and every
// membership-check request the page sends is turned into a refused one (a check that can never finish — what the person
// saw). Then a reload must open the workspace, a new note must be made and the journal opened, with no gate at any point.
// mobile-chrome is Chromium with Pixel 5's window, touch and pixel ratio: an emulation, not a phone.
// Exit code 1 when a check fails; 2 when the browser cannot start.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { serve } from "./serve.mjs";
import { contextOptions, VIEWPORTS } from "../layout-audit/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] === "mobile-chrome" ? "mobile-chrome" : "chromium";
const dirArg = process.argv.indexOf("--dir");
const vp = VIEWPORTS.find((v) => v.id === (engine === "mobile-chrome" ? "pixel5" : "1280"));
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

let browser;
try { browser = await playwright.chromium.launch(); } catch (error) { console.log(`SKIPPED: ${String(error).slice(0, 160)}`); process.exit(2); }
const site = await serve(resolve(here, "../..", dirArg > 0 ? process.argv[dirArg + 1] : "dist-browser"));
const context = await browser.newContext(contextOptions(vp));
const STUCK = "zz-test-membership-check-never-finishes";
// Every page of this context: once the flag is set, the page's membership-check requests to the worker ask for a path
// the backend does not have (404), so the check fails each time it runs — before the fix the gate never came down.
await context.addInitScript((flag) => {
  if (localStorage.getItem(flag) !== "1") return;
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...rest) {
    if (message && message.t === "request" && typeof message.path === "string" && message.path.startsWith("/api/sync/membership")) {
      message = { ...message, path: message.path.replace("/api/sync/membership", "/api/sync/no-such-check") };
    }
    return post.call(this, message, ...rest);
  };
}, STUCK);

const page = await context.newPage();
// Counted by the page itself, so a gate that shows for a moment between two looks is still seen.
const watchGate = () => page.evaluate(() => {
  window.__gateSeen = 0;
  new MutationObserver(() => { if (document.querySelector(".membership-gate")) window.__gateSeen++; }).observe(document.body, { childList: true, subtree: true });
});
const gateSeen = () => page.evaluate(() => window.__gateSeen + (document.querySelector(".membership-gate") ? 1 : 0));

await page.goto(`${site.base}?view=tasks`);
await page.locator(".user-chip").filter({ visible: true }).first().waitFor({ timeout: 120_000 });

// 1. No way to sign out: neither the account menu nor Settings › Account offers it.
await page.locator(".user-chip").filter({ visible: true }).first().click();
const accountDialog = page.locator(".account-dialog");
await accountDialog.waitFor({ timeout: 10_000 });
check(await accountDialog.getByText("登出", { exact: true }).count() === 0, "the account menu has no 「登出」");
await page.keyboard.press("Escape");
await accountDialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

// 2. The state after a sign-out, with a membership check that cannot finish; then a reload.
await page.evaluate((flag) => { localStorage.removeItem("onden_verified_account"); localStorage.setItem(flag, "1"); }, STUCK);
await page.goto(`${site.base}?view=tasks`);
await page.waitForSelector("body");
await watchGate();
await page.locator(".user-chip").filter({ visible: true }).first().waitFor({ timeout: 120_000 });
// The gate used to come up within seconds of the start, and again on any press; give it that time and more.
await page.waitForTimeout(12_000);
check(await gateSeen() === 0, "after the reload the workspace is never locked behind 「正在確認工作區資料…」");

// 3. The workspace works: a new note is made and kept, and the journal opens.
const NOTE = "00000000-0000-4000-8000-000000007301";
const created = await page.evaluate(async (id) => {
  const r = await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: "登出之後的筆記", markdown: "還在" }) });
  return r.ok ? id : null;
}, NOTE);
check(!!created, "a new note is saved");
await page.goto(`${site.base}?view=notes&node=${created}&lens=editor`);
const title = await page.waitForFunction(() => { const input = document.querySelector(".obsidian-title-input"); return input?.value === "登出之後的筆記" && !input.closest("[inert]"); }, null, { timeout: 60_000 }).then(() => true, () => false);
await watchGate();
check(title, "the new note opens in the editor after another reload, and the editor is not locked");
await page.goto(`${site.base}?view=daily`);
const journal = await page.locator(".journal-screen").first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
await watchGate();
check(journal, "the journal opens");
await page.waitForTimeout(6000);
check(await gateSeen() === 0, "no gate while the note and the journal were opened");

await browser.close();
await site.close?.();
if (failures.length) { console.log(`${failures.length} check(s) failed`); process.exit(1); }
console.log(`all checks passed [${engine}]`);

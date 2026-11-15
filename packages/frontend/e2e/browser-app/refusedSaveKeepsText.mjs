// npm run build:browser (repo root), then: node e2e/browser-app/refusedSaveKeepsText.mjs [chromium|mobile-chrome] [--dir dist-browser]
// A title pasted over the 500-character cap makes every save of the note refused by the app itself (nothing is sent).
// The body typed beside it must still be in the recovery panel after the page was closed and the app opened again on
// another note; discarding the entry removes it for good, and the note on the server never received the text.
// mobile-chrome is Chromium with Pixel 5's window, touch and pixel ratio: an emulation, not a phone.
// Exit code 1 when a check fails; 2 when the browser cannot start.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { serve } from "./serve.mjs";
import { contextOptions, VIEWPORTS, READY_TEXT, waitSaved } from "../layout-audit/env.mjs";

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
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOTE = id(7101), OTHER = id(7102);
const BODY = "標題太長時打的內文，換筆記後也要還在";

const openPage = async (path) => {
  const page = await context.newPage();
  await page.goto(`${site.base}${path}`);
  await page.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  return page;
};
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}, { method, path, body });
const leave = async (page) => {
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); });
  await page.waitForTimeout(400);
  await page.close();
};
const until = async (probe, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 400)); } return false; };
const panel = (page) => page.locator(".failed-write-recovery");

let page = await openPage("");
await call(page, "POST", "/api/nodes", { id: NOTE, title: "標題測試筆記", markdown: "原本的內文" });
await call(page, "POST", "/api/nodes", { id: OTHER, title: "另一則筆記", markdown: "" });
await waitSaved(page);
await page.close();

// Paste a 501-character title, then type in the body; the autosave refuses the save.
page = await openPage(`?view=notes&node=${NOTE}&lens=editor`);
const title = page.locator(".obsidian-title-input").first();
const content = page.locator(".md-editor-cm .cm-content").first();
// The editor has seeded its draft from the note once the saved body is on screen; typing earlier would be overwritten by that.
await page.locator(".md-editor-cm .cm-content", { hasText: "原本的內文" }).first().waitFor({ timeout: 60_000 });
// The title box holds the note's own title once the editor has seeded its draft; a paste before that would be reseeded away.
await page.waitForFunction(() => document.querySelector(".obsidian-title-input")?.value === "標題測試筆記", null, { timeout: 60_000 });
await page.waitForLoadState("networkidle");
await title.fill("長".repeat(501));
check((await title.inputValue()).length === 501, "the title box holds the pasted 501 characters");
await content.click();
await page.keyboard.press("Control+End");
await page.keyboard.insertText(`\n${BODY}`);
check(await until(async () => (await panel(page).innerText().catch(() => "")).includes(BODY), 15_000), "the refused save's text is listed in the recovery panel while the note is open");
const shown = await panel(page).innerText().catch(() => "");
check(/500/.test(shown), "the panel says in words why it was not saved (the title cap)", shown.slice(0, 120));
check(!/\{"|_id|uuid|[0-9a-f]{8}-[0-9a-f]{4}/.test(shown), "the panel shows no ids or JSON");
await leave(page);

// Another note, as after closing the tab: the entry is still there; the note on the server never got the text.
page = await openPage(`?view=notes&node=${OTHER}&lens=editor`);
check(await until(async () => (await panel(page).innerText().catch(() => "")).includes(BODY)), "after reopening on another note the text is still in the recovery panel");
const server = await call(page, "GET", `/api/nodes/${NOTE}`);
check(server.markdown === "原本的內文" && server.title === "標題測試筆記", "nothing refused was sent to the server", JSON.stringify([server.title.length, server.markdown.length]));

// Discard removes it for good.
await panel(page).locator(".fwr-dismiss").first().click();
check(await until(async () => (await panel(page).count()) === 0), "discarding removes the entry");
await page.waitForTimeout(500);
await leave(page);
page = await openPage(`?view=notes&node=${OTHER}&lens=editor`);
await page.waitForTimeout(1500);
check((await panel(page).count()) === 0, "after another reload the discarded entry does not come back");
await page.close();

await browser.close();
await site.close?.();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);

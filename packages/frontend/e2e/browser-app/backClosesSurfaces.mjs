#!/usr/bin/env node
// Back closes the newest surface and leaves the page underneath (hooks/useEscapeKey.ts: useDismiss; docs/agents/decisions-ui.md):
//   node e2e/browser-app/backClosesSurfaces.mjs [chromium|mobile-chrome] [--dir dist-browser]
// For each surface: open it, ask the browser to close it the way Android's Back does (a close request, see below),
// and check that only that surface went, the address is unchanged, and no history entry was added by opening it.
//  1. a note's ⋯ menu (a sheet on the phone, a popover on the desktop)
//  2. a date picker inside the task sheet inside 「全部的事」: three requests close picker, sheet, panel, one each
//  3. the phone's Info screen of a note (history Back: page.goBack(); back to the note)
//  4. the notes sidebar's search box (on the phone, on the list)
//
// What this is not: Android's Back. A close request is what the system Back button and gesture send to a page that has
// a CloseWatcher or an open <dialog>; Playwright cannot press that button, but Esc with nothing focused makes the same
// request in Chromium (no key handler of ours sees it), so that is what is sent. "Phone" is Playwright's Pixel 5
// emulation (size, touch), not a device. The desktop toolbar's Back button is history, not a close request: unchanged.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv.slice(2).find((arg) => arg === "chromium" || arg === "mobile-chrome") ?? "chromium";
const phone = engine === "mobile-chrome";
const dirFlag = process.argv.indexOf("--dir");
const site = await serve(resolve(here, "../..", dirFlag > 0 ? process.argv[dirFlag + 1] : "dist-browser"));
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...(phone ? playwright.devices["Pixel 5"] : { viewport: { width: 1280, height: 800 } }), locale: "zh-TW" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  [${engine}] ${name}${detail ? `  (${detail})` : ""}`); };

const visible = (selector) => page.evaluate((s) => [...document.querySelectorAll(s)].some((el) => el.getBoundingClientRect().height > 0), selector);
const historyLength = () => page.evaluate(() => history.length);
const address = () => page.evaluate(() => location.search);
/** The browser's close request: what Back sends. Focus is taken off the surface first so no handler of ours hears the key. */
const closeRequest = async () => {
  await page.evaluate(() => { (document.activeElement)?.blur?.(); });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
};
const noteShown = () => visible(".obsidian-title-input");

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  check("the browser has CloseWatcher (else Back is not tested here)", await page.evaluate(() => typeof CloseWatcher === "function"));
  await page.waitForTimeout(1500);

  // ── 1. A note's ⋯ menu ──────────────────────────────────────────────────────
  {
    const before = { length: await historyLength(), address: await address() };
    await page.getByRole("button", { name: "更多動作" }).first().click();
    await page.waitForTimeout(500);
    check("1. the note's ⋯ menu opens", await visible('[role="menu"][aria-label="更多動作"]'));
    check("1. opening it adds no history entry", (await historyLength()) === before.length);
    await closeRequest();
    check("1. Back closes the menu", !(await visible('[role="menu"][aria-label="更多動作"]')));
    check("1. the note and its address stay", (await noteShown()) && (await address()) === before.address);
  }

  // ── 3. The phone's Info screen ──────────────────────────────────────────────
  if (phone) {
    const before = await address();
    await page.getByRole("button", { name: "資訊" }).first().click();
    await page.waitForTimeout(800);
    const onInfo = !(await noteShown());
    check("3. the Info screen replaces the note", onInfo);
    // Info is a page-sized screen with a history entry of its own (hooks/usePhoneInfoScreen), so its Back is history.
    await page.goBack();
    await page.waitForTimeout(800);
    check("3. Back returns from Info to the note", (await noteShown()) && (await address()) === before);
  }

  // ── 4. The sidebar's search ─────────────────────────────────────────────────
  {
    if (phone) {
      await page.goto(`${site.base}?view=notes`);
      await page.waitForTimeout(1500);
      // The app may still be opening its landing note: tap 筆記 until the list, not a note, is on screen.
      for (let i = 0; i < 12 && !(await visible("[data-sb-id]") && !(await address()).includes("node=")); i++) {
        await page.getByText("筆記", { exact: true }).last().click().catch(() => {});
        await page.waitForTimeout(1200);
      }
    }
    const before = { length: await historyLength(), address: await address() };
    await page.getByRole("button", { name: "搜尋筆記" }).first().click();
    await page.waitForTimeout(500);
    const field = '.search-field input, input[type="search"]';
    check("4. the search box opens", await visible(field));
    await closeRequest();
    check("4. Back closes the search box", !(await visible(field)));
    check("4. the list stays where it was", (await address()) === before.address && (await historyLength()) === before.length);
  }

  // ── 2. 「全部的事」 › task sheet › date picker ───────────────────────────────
  {
    await page.goto(`${site.base}?view=today`);
    await page.getByRole("button", { name: /全部的事/ }).first().waitFor({ state: "visible", timeout: 30_000 });
    const before = { length: await historyLength(), address: await address() };
    await page.getByRole("button", { name: /全部的事/ }).first().click();
    await page.waitForTimeout(600);
    const panel = 'section[aria-label="全部的事"]';
    check("2. 「全部的事」 opens", await visible(panel));
    await page.getByRole("tab", { name: /^隨時/ }).click(); // the sample tasks have no date: they are listed here
    await page.getByRole("button", { name: /^編輯 / }).first().click();
    await page.waitForTimeout(800);
    const sheet = "dialog[open]";
    check("2. a task's sheet opens over it", await visible(sheet));
    await page.locator("dialog[open]").getByRole("button", { name: "選日期…" }).first().click();
    await page.waitForTimeout(600);
    const picker = "dialog[open] .ui-datepicker";
    check("2. the date picker opens in the sheet", await visible(picker));
    check("2. none of this added a history entry", (await historyLength()) === before.length);
    await closeRequest();
    check("2. Back closes the date picker only", !(await visible(picker)) && (await visible(sheet)) && (await visible(panel)));
    await closeRequest();
    check("2. the next Back closes the sheet only", !(await visible(sheet)) && (await visible(panel)));
    await closeRequest();
    check("2. the next closes 「全部的事」, still on the same page", !(await visible(panel)) && (await address()) === before.address);
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("ran to the end", false, String(error).slice(0, 300));
}
await browser.close();
await site.close?.();
process.exit(results.every(Boolean) ? 0 : 1);

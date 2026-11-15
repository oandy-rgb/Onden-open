#!/usr/bin/env node
// ⋯ › 文字樣式 in the browser app: on a desktop window a popover right below the ⋯ (no dimming, stays open while
// choosing, Esc closes and gives focus back); on a phone window a bottom sheet.
//   node e2e/browser-app/textStylePopover.mjs [chromium|mobile-chrome] [--scheme light|dark] [--shots <dir>]
// The phone is an emulated window (Pixel 5 size, touch), not a real device.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const scheme = arg("--scheme") ?? "light";
const shots = arg("--shots") ? resolve(arg("--shots")) : null;
const phone = engine === "mobile-chrome";
const device = playwright.devices[phone ? "Pixel 5" : "Desktop Chrome"];
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, ...(phone ? {} : { viewport: { width: 1280, height: 800 } }), locale: "zh-TW", colorScheme: scheme });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const made = await page.evaluate(async () => (await (await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "文字樣式測試", markdown: "# 文字樣式測試\n\n內文 Ag 永" }) })).json()).id);
  for (let i = 0; i < 60; i++) { const st = await page.evaluate(async () => (await fetch("/api/browser-app/state")).json()); if (!st.unsaved && st.lastSavedAt !== null) break; await page.waitForTimeout(400); }
  await page.goto(`${site.base}?view=notes&node=${made}`);
  await page.locator(".cm-content").first().waitFor({ timeout: 60_000 });
  const whatsNew = page.getByText("這次更新", { exact: true }).first();
  if (await whatsNew.isVisible().catch(() => false)) await whatsNew.locator("xpath=following-sibling::button").first().click().catch(() => {});

  const more = page.getByRole("button", { name: "更多動作" }).first();
  await more.click();
  await page.getByRole("menuitem", { name: "文字樣式" }).click();
  const fontCards = page.getByRole("radiogroup", { name: "字體" }).getByRole("radio");
  const sheetLike = page.locator(phone ? ".ui-sheet" : ".note-text-style-popover");
  await sheetLike.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
  const panel = phone ? page.locator(".ui-sheet", { has: page.getByRole("radiogroup", { name: "字體" }) }) : sheetLike;
  const box = await panel.boundingBox();
  const moreBox = await more.boundingBox();
  const view = page.viewportSize();
  const cards = await fontCards.evaluateAll((els) => els.slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().top)));
  const background = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
  check("the four font cards are on one row", cards.length === 4 && new Set(cards).size === 1, cards.join(","));
  check("the panel has a background", !/rgba\(0, 0, 0, 0\)|transparent/.test(background), background);
  if (phone) {
    check("the phone shows a bottom sheet", Math.abs(box.y + box.height - view.height) < 4 && box.width >= view.width - 2, `${Math.round(box.y + box.height)} of ${view.height}`);
  } else {
    check("the panel is 360px wide", Math.abs(box.width - 360) < 1, `${box.width}`);
    check("its right edge lines up with the ⋯", Math.abs(box.x + box.width - (moreBox.x + moreBox.width)) <= 8, `${Math.round(box.x + box.width)} vs ${Math.round(moreBox.x + moreBox.width)}`);
    check("it opens below the ⋯", box.y >= moreBox.y + moreBox.height, `${Math.round(box.y)} vs ${Math.round(moreBox.y + moreBox.height)}`);
    check("the page behind is not dimmed (no backdrop)", (await page.locator(".ui-sheet-backdrop, dialog[open]").count()) === 0);
    const before = await page.locator(".cm-content").first().evaluate((el) => getComputedStyle(el).fontFamily);
    await page.getByRole("radio", { name: "等寬" }).click();
    await page.waitForTimeout(400);
    check("choosing a font keeps the panel open", await sheetLike.isVisible());
    const after = await page.locator(".cm-content").first().evaluate((el) => getComputedStyle(el).fontFamily);
    check("the note's font changed", before !== after && (await page.evaluate(() => localStorage.getItem("note.font"))) === "mono", `${before.slice(0, 20)} → ${after.slice(0, 20)}`);
  }
  if (shots) await page.screenshot({ path: join(shots, `text-style-${phone ? "phone" : "desktop"}-${scheme}.png`) });
  if (!phone) {
    await page.keyboard.press("Escape");
    await sheetLike.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    check("Esc closes it", (await sheetLike.count()) === 0);
    check("focus is back on the ⋯", await more.evaluate((el) => el === document.activeElement));
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("the run finished", false, String(error).split("\n")[0]);
  await page.screenshot({ path: join(here, `failed-text-style-${engine}.png`) }).catch(() => {});
} finally {
  await browser.close();
  site.close();
}
process.exit(results.every(Boolean) ? 0 : 1);

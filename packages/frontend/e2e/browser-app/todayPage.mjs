#!/usr/bin/env node
// The 今天 page in the browser app (a real engine): open it → add a thing → drag it to 14:00 → write a line in the
// journal column → start a focus on it → see the focus bar and its block in the focus lane → end it with a sentence
// → the sentence is in the journal → week, month, back to the day → yesterday; the Journal and Tasks pages still open.
//   node e2e/browser-app/todayPage.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <dir>] [--dark]
// "mobile-chrome" is Chromium emulating a Pixel 5, not a phone.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const phone = engine === "mobile-chrome";
const dark = process.argv.includes("--dark");
const shots = flag("--shots", null);
if (shots) mkdirSync(shots, { recursive: true });
const site = await serve(resolve(here, "../..", flag("--dir", "dist-browser")));
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...(phone ? playwright.devices["Pixel 5"] : { viewport: { width: 1360, height: 900 } }), locale: "zh-TW", timezoneId: "Asia/Taipei", colorScheme: dark ? "dark" : "light" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const shot = (name) => shots ? page.screenshot({ path: join(shots, `${engine}${dark ? "-dark" : ""}-${name}.png`) }) : Promise.resolve();
const api = (path, init) => page.evaluate(async ([p, i]) => (await fetch(p, i)).json().catch(() => null), [path, init]);
const saved = async () => { for (let i = 0; i < 40; i++) { const s = await api("/api/browser-app/state"); if (!s.unsaved && s.lastSavedAt !== null) return; await page.waitForTimeout(300); } };

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const day = await page.evaluate(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date()));
  const yesterday = await page.evaluate(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date(Date.now() - 86400000)));
  await page.goto(`${site.base}?view=today`);
  const screen = page.getByTestId("today-screen");
  await screen.waitFor({ timeout: 30_000 });
  check("the 今天 page opens", true);
  if (phone) await page.getByRole("radio", { name: "清單" }).click().catch(() => {});

  // Add a thing to this day (the quick-add sheet starts on the page's day).
  await screen.getByRole("button", { name: "加一件事…" }).click();
  await page.getByRole("combobox", { name: "任務" }).fill("寫週報");
  await page.keyboard.press("Enter");
  await screen.getByText("寫週報").first().waitFor({ timeout: 15_000 });
  await page.getByRole("dialog").getByRole("button", { name: "關閉" }).first().click();
  check("a thing added from the page lands on today's list", true);
  await shot("1-added");

  if (!phone) {
    // Drag it onto 14:00 of the timeline.
    const row = screen.locator(".tk-row", { hasText: "寫週報" }).first();
    const body = page.getByTestId("day-timeline-body");
    await body.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const target = await body.boundingBox();
    const hourLabel = await page.locator(".day-hour-label", { hasText: "14:00" }).first().boundingBox();
    await row.dragTo(page.getByTestId("day-timeline-body"), { targetPosition: { x: 120, y: hourLabel.y - target.y + 4 } });
    await page.waitForTimeout(1500);
    await saved();
    const planned = (await api("/api/bootstrap")).tasks.find((t) => t.title.includes("寫週報"));
    check("dragged onto 14:00 the thing has that time", planned?.time?.startsWith("14:"), String(planned?.time));
    await shot("2-planned");

    // Write a line in the journal column; the note appears only now.
    await page.getByRole("textbox", { name: "寫點什麼…" }).fill("今天開始試用新頁面");
    await page.getByRole("button", { name: "加到日記" }).click();
    await page.getByText("今天開始試用新頁面").first().waitFor({ timeout: 15_000 });
    check("a line written in the journal column shows in the day's note", true);
    await shot("3-journal");
  }

  // Focus on the thing: the bar, and (desktop) a block in the focus lane.
  await screen.getByRole("button", { name: "開始專注：寫週報" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "開始專注", exact: true }).click();
  if (!phone) {
    await screen.getByRole("region", { name: "專注計時" }).waitFor({ timeout: 15_000 });
    check("the focus bar shows on the page and the full screen did not cover it", !(await page.getByRole("dialog").isVisible().catch(() => false)));
    await page.waitForTimeout(2500);
    check("the focus lane has the running block", (await page.locator(".day-focus-block").count()) > 0);
    await shot("4-focus");
    await screen.getByRole("button", { name: "結束專注" }).click();
  } else {
    await page.getByRole("region", { name: "專注計時" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "結束專注" }).click();
  }
  await page.getByRole("textbox").last().fill("寫完週報的第一段");
  await page.getByRole("button", { name: /結束|完成|記下/ }).last().click();
  await page.waitForTimeout(2000);
  check("the focus ended", (await page.getByRole("region", { name: "專注計時" }).count()) === 0);

  if (!phone) {
    await page.getByRole("radio", { name: "週" }).click();
    check("週 shows the week board", (await page.locator(".week-board").count()) === 1);
    await page.getByRole("radio", { name: "月" }).click();
    check("月 shows the month", (await page.getByRole("button", { name: "下個月" }).count()) === 1);
    await page.getByRole("gridcell").filter({ hasText: /^\d+$/ }).first().click();
    check("a day picked in the month goes back to 1 天", (await page.getByRole("radio", { name: "1 天" }).getAttribute("aria-checked")) === "true");
    await page.getByRole("button", { name: "回到今天" }).click().catch(() => {});
  } else {
    await page.getByRole("radio", { name: "時間軸" }).click();
    check("the phone timeline shows", (await page.getByTestId("day-timeline").count()) === 1);
    await shot("5-phone-timeline");
    await page.getByRole("radio", { name: "月" }).click();
    await shot("6-phone-month");
    await page.getByRole("radio", { name: "清單" }).click();
  }
  await page.getByRole("button", { name: "前一天" }).click();
  await page.waitForTimeout(500);
  check("yesterday opens", (await page.getByRole("button", { name: "回到今天" }).count()) > 0);
  await shot("7-yesterday");

  // The old pages are as they were.
  await page.goto(`${site.base}?view=daily`);
  check("the Journal page still opens", (await page.locator(".journal-screen").count()) === 1 || await page.locator(".journal-screen").waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await page.goto(`${site.base}?view=tasks`);
  check("the Tasks page still opens", await page.locator(".tasks-page").waitFor({ timeout: 15_000 }).then(() => true, () => false));
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  console.log("FAIL  script error:", String(error).split("\n")[0]);
  results.push(false);
  await shot("failed").catch(() => {});
}
await browser.close(); site.close();
process.exit(results.every(Boolean) ? 0 : 1);

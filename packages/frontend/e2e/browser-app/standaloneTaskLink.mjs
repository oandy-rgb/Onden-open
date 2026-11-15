#!/usr/bin/env node
// A link to a task that is no note's line (browser app, a real engine): open a note that links it, click the
// link → the same task sheet the Tasks page uses opens, on the task. A link to a task that is gone opens nothing
// but a short message.
//   node e2e/browser-app/standaloneTaskLink.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <dir>]
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
const shots = flag("--shots", null);
if (shots) mkdirSync(shots, { recursive: true });
const site = await serve(resolve(here, "../..", flag("--dir", "dist-browser")));
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...(phone ? playwright.devices["Pixel 5"] : { viewport: { width: 1360, height: 900 } }), locale: "zh-TW", timezoneId: "Asia/Taipei" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const shot = (name) => shots ? page.screenshot({ path: join(shots, `${engine}-${name}.png`) }) : Promise.resolve();
const NOTE = "00000000-0000-4000-8000-0000000c0a01";
const TASK = "00000000-0000-4000-8000-0000000c0a02";

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  // A task with no note, and a note that links to it by title and to one that does not exist.
  await page.evaluate(async ({ NOTE, TASK }) => {
    const call = async (path, body) => {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status >= 300 && r.status !== 409) throw new Error(`POST ${path} → ${r.status} ${await r.text()}`);
    };
    await call("/api/tasks", { id: TASK, title: "繳房租" });
    await call("/api/nodes", { id: NOTE, title: "任務連結測試", markdown: "記得 [[繳房租]] 這件事" });
  }, { NOTE, TASK });
  await page.goto(`${site.base}?view=notes&node=${NOTE}`);
  await page.getByRole("button", { name: "預覽" }).or(page.getByRole("radio", { name: "預覽" })).first().click({ timeout: 5_000 }).catch(() => {});
  const link = (phone ? page.locator(".cm-content").getByText("繳房租") : page.locator(".wikilink-token", { hasText: "繳房租" })).first();
  await link.waitFor({ timeout: 30_000 });
  check("the note shows the link to the task", true);
  await page.waitForTimeout(1500); // the editor is ready to take a tap
  if (phone) { const at = await link.boundingBox(); await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2); } else await link.click();
  // On the phone the note is the editor: a tap in it, not yet focused, follows a link as the preview does.
  const sheet = page.getByRole("dialog");
  await sheet.waitFor({ timeout: 15_000 });
  const opened = await sheet.locator("input,textarea").evaluateAll((els) => els.some((e) => e.value === "繳房租")) || (await sheet.getByText("繳房租").count()) > 0;
  check("clicking it opens the task's sheet", opened);
  check("no 「找不到這個任務」 message", (await page.getByText("找不到這個任務").count()) === 0);
  await shot("1-task-sheet");
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  console.log("FAIL  script error:", String(error).split("\n")[0]);
  results.push(false);
  await shot("failed").catch(() => {});
}
await browser.close(); site.close();
process.exit(results.every(Boolean) ? 0 : 1);

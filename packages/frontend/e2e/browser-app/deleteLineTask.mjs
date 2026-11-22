#!/usr/bin/env node
// Deleting a task that is a line of a note (browser app, a real engine): write a task line in a note, open its sheet from
// the Tasks page, 「刪除任務」 → the row is gone at once, the note no longer has the line, and after the note is edited and
// saved the task is still gone (it used to come back: the note's save restored a task whose line was still there).
// 「復原」 on the toast puts the line back in the note and the task on the page.
//   node e2e/browser-app/deleteLineTask.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <dir>]
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
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, path, body]);
const NOTE = "00000000-0000-4000-8000-0000000d1e01";
const BODY = "# 作業系統 W9\n\n- [ ] 寫期中報告 {task}\n- [ ] 另一項 {task}\n";
const taskNamed = async (title) => ((await call("GET", "/api/bootstrap")).body.tasks ?? []).find((t) => t.title === title);
const noteBody = async () => (await call("GET", `/api/nodes/${NOTE}`)).body.markdown;

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  check("the note is made", (await call("POST", "/api/nodes", { id: NOTE, title: "作業系統 W9 虛擬記憶體", markdown: BODY })).status === 201);
  const task = await taskNamed("寫期中報告");
  check("its line made the task", !!task);
  // Planned for today so it is on the Tasks page's list.
  const today = await page.evaluate(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date()));
  check("planned for today", (await call("PATCH", `/api/tasks/${task.id}`, { when_date: today })).status === 200);
  await page.goto(`${site.base}?view=tasks`);
  await page.locator(".tasks-page").waitFor({ timeout: 30_000 });
  const row = page.locator(".tk-row", { hasText: "寫期中報告" }).first();
  await row.waitFor({ timeout: 15_000 });
  check("the Tasks page lists it", true);
  await row.getByRole("button", { name: "Edit 寫期中報告" }).or(row.locator(".tk-main")).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.waitFor({ timeout: 15_000 });
  check("its sheet says the line is in the note", (await sheet.getByText("筆記裡那一行也會拿掉").count()) === 1);
  await shot("1-sheet");
  await sheet.getByRole("button", { name: /刪除任務/ }).click();
  await page.locator(".tk-row", { hasText: "寫期中報告" }).waitFor({ state: "detached", timeout: 15_000 });
  check("the row is gone at once", true);
  await shot("2-deleted");

  // The server took the line out of the note in the same delete.
  let body = "";
  for (let i = 0; i < 30; i++) { body = await noteBody(); if (!body.includes("寫期中報告")) break; await page.waitForTimeout(300); }
  check("the note no longer has the line", !body.includes("寫期中報告") && body.includes("另一項 {task}"), JSON.stringify(body));

  // Edit and save the note: the task must stay deleted.
  check("the note is edited and saved", (await call("PATCH", `/api/nodes/${NOTE}`, { markdown: `${body}\n複習第九章\n` })).status === 200);
  check("the task stays deleted", (await taskNamed("寫期中報告")) === undefined);
  await page.goto(`${site.base}?view=tasks`);
  await page.locator(".tasks-page").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  check("after a reload the row is still gone", (await page.locator(".tk-row", { hasText: "寫期中報告" }).count()) === 0);
  check("the other task is untouched", (await page.getByText("另一項").count()) >= 0 && !!(await taskNamed("另一項")));

  // Undo on the toast: the line is back in the note at its place and the task is on the page again.
  const kept = await noteBody();
  const other = page.locator(".tk-row", { hasText: "另一項" }).first();
  await other.waitFor({ timeout: 15_000 });
  await other.locator(".tk-main").click();
  await page.getByRole("dialog").getByRole("button", { name: /刪除任務/ }).click();
  await page.locator(".tk-row", { hasText: "另一項" }).waitFor({ state: "detached", timeout: 15_000 });
  let gone = "";
  for (let i = 0; i < 30; i++) { gone = await noteBody(); if (!gone.includes("另一項")) break; await page.waitForTimeout(300); }
  check("deleting the second task takes its line out too", !gone.includes("另一項"), JSON.stringify(gone));
  await shot("3-second-deleted");
  await page.getByRole("button", { name: "復原" }).first().click();
  let back = "";
  for (let i = 0; i < 40; i++) { back = await noteBody(); if (back === kept) break; await page.waitForTimeout(300); }
  check("Undo writes the line back at its place", back === kept, JSON.stringify(back));
  await page.locator(".tk-row", { hasText: "另一項" }).first().waitFor({ timeout: 15_000 });
  check("and the task is on the page again", true);
  await shot("4-undone");
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  console.log("FAIL  script error:", String(error).split("\n")[0]);
  results.push(false);
  await shot("failed").catch(() => {});
}
await browser.close(); site.close();
process.exit(results.every(Boolean) ? 0 : 1);

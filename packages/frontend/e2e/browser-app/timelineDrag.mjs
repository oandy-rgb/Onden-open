#!/usr/bin/env node
// Drag a planned block on the 日記 timeline in the browser app (a real engine): the task line's time changes.
//   node e2e/browser-app/timelineDrag.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <dir>]
// "mobile-chrome" is Chromium emulating a Pixel 5 viewport and touch — not a phone. It checks that a scroll
// does not drag and that a hold-then-drag does; real fingers and real scrolling inertia are not covered.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engineName = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve(here, "../..", flag("--dir", "dist-browser"));
const shots = flag("--shots", null);
if (shots) mkdirSync(shots, { recursive: true });
const phone = engineName === "mobile-chrome";
const device = playwright.devices[phone ? "Pixel 5" : "Desktop Chrome"];
const site = await serve(root);
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, locale: "zh-TW", timezoneId: "Asia/Taipei" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
const shot = (name) => shots ? page.screenshot({ path: join(shots, `${engineName}-${name}.png`) }) : Promise.resolve();

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const today = await page.evaluate(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date()));
  // A note with one task line, then the task planned 10:00–11:00 today (what planning a time does).
  const taskId = await page.evaluate(async (day) => {
    await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "拖曳測試筆記", markdown: "- [ ] 拖我 {task}" }) });
    const boot = await (await fetch("/api/bootstrap")).json();
    const task = boot.tasks.find((row) => row.title.includes("拖我"));
    await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ when_date: day, time: "10:00", until: "11:00" }) });
    return task.id;
  }, today);
  // The browser's copy catches up a moment after a write; reload only when it has.
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(async () => (await fetch("/api/browser-app/state")).json());
    if (!state.unsaved && state.lastSavedAt !== null) break;
    await page.waitForTimeout(400);
  }
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  // The timeline is the 任務 page's (JournalScreen has none: the journal looks back). A phone reaches it from the bottom tab, a desktop from the sidebar.
  const tasksEntry = page.getByRole("button", { name: "任務", exact: true }).or(page.getByRole("link", { name: "任務", exact: true }));
  await (phone ? tasksEntry.last() : tasksEntry.first()).click({ timeout: 20_000 });
  const timeline = page.getByTestId("day-timeline");
  await timeline.waitFor({ timeout: 30_000 });
  const block = page.locator(".day-block", { hasText: "拖我" }).first();
  await block.waitFor({ timeout: 20_000 });
  // Mid-screen: near the edge the timeline scrolls by itself while a block is dragged (that is tested apart).
  await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const lineOf = () => page.evaluate(async (id) => (await (await fetch("/api/bootstrap")).json()).tasks.find((row) => row.id === id), taskId);
  // The write is accepted a moment after the gesture ends: wait for the value, up to 15 s.
  const lineIs = async (field, value) => { for (let i = 0; i < 75; i++) { if ((await lineOf())[field] === value) return true; await page.waitForTimeout(200); } return false; };
  const hourPx = 56;
  const box = async () => (await block.boundingBox());
  const b0 = await box();
  await shot("0-before");

  if (!phone) {
    // Mouse: press the block, drag 1 hour down, let go.
    await page.mouse.move(b0.x + b0.width / 2, b0.y + 10);
    await page.mouse.down();
    await page.mouse.move(b0.x + b0.width / 2, b0.y + 10 + hourPx / 2, { steps: 4 });
    await page.mouse.move(b0.x + b0.width / 2, b0.y + 10 + hourPx, { steps: 4 });
    await shot("1-dragging");
    const during = await lineOf();
    check("nothing is written while dragging", during.time === "10:00" && during.until === "11:00");
    await page.mouse.up();
    await lineIs("time", "11:00");
    const moved = await lineOf();
    check("drag a block 1 hour down: the task is now 11:00–12:00", moved.time === "11:00" && moved.until === "12:00", `${moved.time}–${moved.until}`);

    // Lower edge: hover shows the grip, pull it 30 minutes.
    const b1 = await box();
    await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
    const grip = page.getByTestId("day-block-grip").first();
    await shot("2-grip");
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + hourPx / 2, { steps: 6 });
    await page.mouse.up();
    await lineIs("until", "12:30");
    const stretched = await lineOf();
    check("pull the lower edge 30 minutes: the end is 12:30", stretched.time === "11:00" && stretched.until === "12:30", `${stretched.time}–${stretched.until}`);

    // Keyboard.
    await block.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Alt+ArrowUp");
    await lineIs("time", "10:30");
    const keyed = await lineOf();
    check("Alt+↑ twice: 30 minutes earlier", keyed.time === "10:30" && keyed.until === "12:00", `${keyed.time}–${keyed.until}`);
  } else {
    const x = b0.x + b0.width / 2;
    const y = b0.y + 12;
    const cdp = await context.newCDPSession(page);
    const touch = (type, py) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: py }] });
    // A swipe (moves before the hold is up) scrolls; it must not move the task.
    await touch("touchStart", y);
    await touch("touchMove", y + 40);
    await touch("touchMove", y + 90);
    await touch("touchEnd", y + 90);
    await page.waitForTimeout(600);
    const afterScroll = await lineOf();
    check("a swipe over a block does not move the task", afterScroll.time === "10:00" && afterScroll.until === "11:00");

    // A swipe that starts on the (not yet selected) lower edge scrolls too: it must not change the length.
    await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    const edge = await page.getByTestId("day-block-grip").first().boundingBox();
    const ex = edge.x + edge.width / 2, ey = edge.y + edge.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: ex, y: ey }] });
    for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: ex, y: ey + i * 12 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(600);
    const afterEdge = await lineOf();
    check("a swipe starting on the unselected lower edge does not change the length", afterEdge.time === "10:00" && afterEdge.until === "11:00", `${afterEdge.time}–${afterEdge.until}`);

    await block.evaluate((el) => el.scrollIntoView({ block: "center" })); // the swipe scrolled the page: back to mid-screen
    await page.waitForTimeout(300);
    const b1 = await box();
    const y1 = b1.y + 12;
    const touch1 = (type, py) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: py }] });
    await touch1("touchStart", y1);
    await page.waitForTimeout(450); // longer than the hold
    for (let i = 1; i <= 8; i++) await touch1("touchMove", y1 + (hourPx * i) / 8);
    await shot("1-dragging");
    await touch1("touchEnd", y1 + hourPx);
    await lineIs("time", "11:00");
    const moved = await lineOf();
    check("hold, then drag 1 hour down: the task is now 11:00–12:00", moved.time === "11:00" && moved.until === "12:00", `${moved.time}–${moved.until}`);

    // Hold and let go in place: selected, the grip is finger-sized; pull it (mid-screen, away from the auto-scroll edge).
    await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    const b2 = await box();
    const y2 = b2.y + 12;
    await touch1("touchStart", y2);
    await page.waitForTimeout(450);
    await touch1("touchEnd", y2);
    const grip = page.getByTestId("day-block-grip").first();
    const gb = await grip.boundingBox();
    check("selected: the grip is a finger-sized target (≥ 28px)", gb.height >= 28, `${gb.height}px`);
    await shot("2-grip");
    const gx = gb.x + gb.width / 2, gy = gb.y + gb.height / 2;
    const gt = (type, py) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: gx, y: py }] });
    await gt("touchStart", gy);
    for (let i = 1; i <= 4; i++) await gt("touchMove", gy + (hourPx * i) / 8);
    await gt("touchEnd", gy + hourPx / 2);
    await lineIs("until", "12:30");
    const stretched = await lineOf();
    check("pull the grip 30 minutes: the end is 12:30", stretched.until === "12:30", `${stretched.time}–${stretched.until}`);
  }
  check("no script errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check(`run to the end (${String(error.message).split("\n")[0]})`, false);
  await page.screenshot({ path: join(shots ?? here, `failed-timeline-${engineName}.png`) }).catch(() => {});
}
await browser.close();
site.close();
console.log(`\n${engineName}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

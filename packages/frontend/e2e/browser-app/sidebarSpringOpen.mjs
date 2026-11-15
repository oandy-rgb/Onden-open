#!/usr/bin/env node
// Spring-loaded folders in the sidebar, in a real engine against the browser app (no server needed):
// a held note that stays over a folded note opens it; the drop keeps only its own path open; what the drag opened
// on the way folds back; the drop survives a reload.
//   node e2e/browser-app/sidebarSpringOpen.mjs [chromium|mobile-chrome] [--dir dist-browser]
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const dirFlag = process.argv.indexOf("--dir");
const shots = process.argv.indexOf("--shots");
const shotDir = shots > 0 ? process.argv[shots + 1] : null;
const mobile = engine === "mobile-chrome";
const site = await serve(resolve(here, "../..", dirFlag > 0 ? process.argv[dirFlag + 1] : "dist-browser"));
const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ ...playwright.devices[mobile ? "Pixel 5" : "Desktop Chrome"], locale: "zh-TW", deviceScaleFactor: 2 });
const page = await ctx.newPage();
const failures = [];
page.on("pageerror", (e) => failures.push(`page error: ${String(e).slice(0, 160)}`));
const check = (name, ok, detail = "") => { if (!ok) failures.push(name); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const shot = async (name) => { if (shotDir) await page.screenshot({ path: join(shotDir, `${mobile ? "phone" : "desktop"}-${name}.png`) }); };

const row = (title) => page.locator("[data-sb-id]").filter({ hasText: title }).last(); // last: the innermost (a folder contains its children' text)
const head = (title) => row(title).locator(".obsidian-group-header, .obsidian-page-button").first();
const expanded = async (title) => row(title).getAttribute("data-sb-expanded");
const center = async (loc) => { await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const touch = (type, x, y, sel) => page.evaluate(({ type, x, y, sel }) => {
  (sel ? document.querySelector(sel) : window).dispatchEvent(new PointerEvent(type, { pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
}, { type, x, y, sel });

/** Holds `from`'s row, then `steps` = [{ over: title, wait: ms }] one after another; releases over the last. */
async function drag(from, steps, { release = true } = {}) {
  const src = await center(head(from));
  const id = await row(from).getAttribute("data-sb-id");
  if (mobile) {
    await touch("pointerdown", src.x, src.y, `[data-sb-id="${id}"]`);
    await page.waitForTimeout(450);
    await touch("pointermove", src.x + 12, src.y + 12);
  } else {
    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(src.x + 10, src.y + 10, { steps: 4 });
  }
  let at = src;
  for (const step of steps) {
    at = await center(head(step.over));
    if (mobile) await touch("pointermove", at.x, at.y); else await page.mouse.move(at.x, at.y, { steps: 5 });
    if (step.wait) await page.waitForTimeout(step.wait);
    await step.after?.();
  }
  if (!release) return at;
  if (mobile) { await page.waitForTimeout(120); await touch("pointerup", at.x, at.y); } else await page.mouse.up();
  await page.waitForTimeout(600);
  return at;
}
const toggle = async (title) => row(title).locator(".obsidian-group-toggle").first().click();

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  await page.waitForTimeout(2500);
  if (mobile) await page.locator(".omt-back").click({ timeout: 3000 }).catch(() => {});
  await page.getByText("這次更新", { exact: true }).first().locator("xpath=following-sibling::button").first().click({ timeout: 1500 }).catch(() => {});

  // Two folders: 讀書筆記 (holds 資料存在哪裡) and 今天要做的事 (holds 快速上手), both folded again afterwards.
  await drag("資料存在哪裡", [{ over: "讀書筆記", wait: 200 }]);
  await drag("快速上手", [{ over: "今天要做的事", wait: 200 }]);
  for (const t of ["讀書筆記", "今天要做的事"]) if ((await expanded(t)) === "true") await toggle(t);
  check("setup: both folders are folded", (await expanded("讀書筆記")) === "false" && (await expanded("今天要做的事")) === "false");

  // Pass over a folder without stopping: it stays folded.
  await drag("歡迎來到 Onden 試用版", [{ over: "今天要做的事", wait: 250 }, { over: "讀書筆記", wait: 0 }], { release: false });
  check("passing over a folded note does not open it", (await expanded("今天要做的事")) === "false");

  // Stay: a hint while waiting, then it opens (not before the delay).
  const waitMs = mobile ? 900 : 700;
  const t0 = Date.now();
  const early = await expanded("讀書筆記");
  check("a hint shows while it waits", await row("讀書筆記").evaluate((el) => el.classList.contains("sb-drop-spring")));
  await shot("waiting");
  check("stays folded before the delay", early === "false" && Date.now() - t0 < waitMs);
  await page.waitForFunction(() => document.querySelector("[data-sb-expanded='true']"), null, { timeout: 4000 });
  const opened = Date.now() - t0;
  check("opens after the delay", (await expanded("讀書筆記")) === "true" && opened < waitMs + 600, `${opened} ms after the first check (delay ${waitMs})`);
  await page.waitForTimeout(200);
  await shot("opened");

  // Release over its child: it lands inside, the folder stays open, the other folder is folded.
  const kid = await center(head("資料存在哪裡"));
  if (mobile) await touch("pointermove", kid.x, kid.y); else await page.mouse.move(kid.x, kid.y, { steps: 4 });
  await page.waitForTimeout(150);
  if (mobile) await touch("pointerup", kid.x, kid.y); else await page.mouse.up();
  await page.waitForTimeout(800);
  await shot("dropped");
  const nested = await page.evaluate(() => {
    const own = (e) => e.querySelector(".obsidian-page-button")?.textContent ?? "";
    const kidRow = [...document.querySelectorAll("[data-sb-id]")].find((e) => own(e).includes("歡迎來到 Onden 試用版"));
    return kidRow?.parentElement?.closest("[data-sb-kind='group']") ? own(kidRow.parentElement.closest("[data-sb-kind='group']")) : null;
  });
  check("the note landed inside the folder's child", !!nested && nested.includes("資料存在哪裡"), String(nested));
  check("the dropped folder stays open", (await expanded("讀書筆記")) === "true");
  check("the folder only passed over is folded", (await expanded("今天要做的事")) === "false");

  await page.reload();
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForTimeout(2500);
  check("after a reload: the path is still open", (await expanded("讀書筆記")) === "true");
  check("after a reload: the other folder is still folded", (await expanded("今天要做的事")) === "false");

  // Esc (a keyboard): what the drag opened folds back, nothing moves.
  if (!mobile) {
    await drag("資料存在哪裡", [{ over: "今天要做的事", wait: waitMs + 400 }], { release: false });
    check("held long enough: it opens", (await expanded("今天要做的事")) === "true");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Esc folds it back", (await expanded("今天要做的事")) === "false");
    await page.mouse.up();
  }
} catch (error) {
  failures.push(`threw: ${String(error.message).split("\n")[0]}`);
  console.log(`FAIL  ${String(error.stack).split("\n").slice(0, 4).join(" | ")}`);
} finally {
  await browser.close();
  site.close();
}
console.log(failures.length ? `\nFAILED: ${failures.join("; ")}` : "\nall passed");
process.exit(failures.length ? 1 : 0);

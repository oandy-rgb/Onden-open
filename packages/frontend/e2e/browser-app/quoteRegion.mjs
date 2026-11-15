#!/usr/bin/env node
// Quoting an area of a handwriting page (docs/agents/decisions-canvas.md 「手寫頁的引用一塊區域」), in a real engine:
// draw → frame an area with the 「引用」 tool → 「複製引用」 → paste into another note → the area shows there → write
// more in it on the source page → the embed shows it → tap the embed → the page opens at the area → back returns.
//   node e2e/browser-app/quoteRegion.mjs [chromium|mobile-chrome] [--dir dist-browser] [--out <folder>]
// The pointer is a mouse (Playwright's mouse events), on the phone size too: a finger or a pen is not tested here.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve(here, "../..", arg("--dir", "dist-browser"));
const out = resolve(arg("--out", join(here, "shots")));
mkdirSync(out, { recursive: true });
const site = await serve(root);
const device = playwright.devices[engine === "mobile-chrome" ? "Pixel 5" : "Desktop Chrome"];
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, locale: "zh-TW" });
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const shot = (name) => page.screenshot({ path: join(out, `${engine}-${name}.png`) });
// The app's own worker is up once /api is bridged to it (a static server answers /api/… with 404 before that).
const workerUp = async () => { const end = Date.now() + 120_000; while (Date.now() < end) { if (await page.evaluate(async () => { try { return (await fetch("/api/browser-app/state")).ok; } catch { return false; } }).catch(() => false)) return true; await page.waitForTimeout(500); } return false; };
const open = async () => { await page.goto(site.base); if (!(await workerUp())) throw new Error("the app's worker did not start"); };
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return r.status === 204 ? null : r.json();
}, [method, path, body]);
const until = async (probe, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await page.waitForTimeout(300); } return false; };
const storedInk = async (id) => (await api("GET", `/api/nodes/${id}/attributes?keys=ink_data`))?.find?.((a) => a.key === "ink_data")?.value ?? null;
const storedStrokes = async (id) => { try { return JSON.parse(await storedInk(id)).strokes.length; } catch { return 0; } };
const stroke = (id, points) => ({ id, color: "#1e1e1e", size: 4, toolId: "pen", points: points.map(([x, y], i) => [x, y, 0.5, i * 8]) });
const seed = { version: 1, erased: {}, page: { width: 1000 }, strokes: [stroke("s1", [[150, 350], [250, 400], [350, 360], [450, 420]])] };
const goNote = async (id, ready) => { await page.goto(`${site.base}?view=notes&node=${id}`); await ready.first().waitFor({ timeout: 40_000 }); };
const sheet = () => page.locator('[data-page-key="page"]').first();
/** A point on the page sheet, in page units (the page is 1000 units wide). */
const at = async (x, y) => { const box = await sheet().boundingBox(); return { x: box.x + (x / 1000) * box.width, y: box.y + (y / 1000) * box.width }; };
const drag = async (from, to) => { const a = await at(...from), b = await at(...to); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up(); };

try {
  await open();
  const source = await api("POST", "/api/nodes", { title: "手寫來源", markdown: "" });
  await api("PUT", `/api/nodes/${source.id}/attributes/ink_data`, { value: JSON.stringify(seed), value_type: "text", is_inheritable: false });
  const target = await api("POST", "/api/nodes", { title: "讀書筆記", markdown: "引用一塊：\n\n" });
  check("the notes were made", !!source?.id && !!target?.id);
  // The browser app keeps its copy after a quiet moment: reload only once it says everything is saved (not after a fixed time).
  await until(async () => { const state = await api("GET", "/api/browser-app/state"); return !state.unsaved && state.lastSavedAt !== null; });
  await open();

  // 1 — frame an area on the handwriting page and copy the reference.
  await goNote(source.id, page.locator(".ink-note"));
  await sheet().waitFor();
  await page.locator(".pagebook path, .pagebook canvas").first().waitFor({ timeout: 20_000 }); // the stored stroke is drawn (an SVG, or the pen surface's canvas)
  await shot("1-source");
  const tool = page.locator('button.ink-tool-btn[aria-label^="引用"]').first();
  check("the toolbar has an 「引用」 tool", await tool.isVisible().catch(() => false));
  // On a phone the toolbar sits under the page (the note scrolls as a whole): bring it up, then use it.
  await tool.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await tool.click();
  check("the tool is on", (await tool.getAttribute("aria-pressed")) === "true");
  await sheet().evaluate((el) => el.scrollIntoView({ block: "start" }));
  await drag([100, 300], [500, 460]);
  const copy = page.locator(".ink-region-copy");
  check("a frame and a visible 「複製引用」 button appear (not in a ⋯ menu)", await copy.isVisible().catch(() => false));
  await shot("2-framed");
  await copy.click();
  const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  check("the clipboard holds the embed of that area", /^!\[\[手寫來源\|ink=page@\d+,\d+,\d+,\d+\]\]$/.test(text), text);
  check("the button says it was copied", await page.getByText("已複製").first().isVisible().catch(() => false));
  await page.keyboard.press("Escape");
  check("Esc puts the frame away", !(await page.locator(".ink-region-frame").count()));
  const region = /ink=page@(\d+),(\d+),(\d+),(\d+)/.exec(text)?.slice(1).map(Number) ?? [];
  check("the area is about the dragged one", Math.abs(region[0] - 100) < 8 && Math.abs(region[1] - 300) < 8 && Math.abs(region[2] - 400) < 12 && Math.abs(region[3] - 160) < 12, region.join(","));

  // 2 — paste it into another note: the area shows there.
  await goNote(target.id, page.locator(".cm-content", { hasText: "引用一塊" }));
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("Control+V");
  await page.keyboard.type("\n\n結束");
  const shown = await until(async () => (await page.locator(".cm-embed .md-drawing-picture--region svg").count()) > 0);
  check("the pasted line shows the area as a picture in the editor", shown);
  check("it is not shown as its syntax", !(await editor.innerText()).includes("ink="));
  const paths = () => page.locator(".cm-embed .md-drawing-picture--region svg path").count();
  const before = await paths();
  const pic = await page.locator(".cm-embed .md-drawing-picture--region").first().boundingBox();
  const col = await editor.boundingBox();
  check("it fits the content column", !!pic && pic.width <= col.width + 1, `${pic?.width} <= ${col.width}`);
  await shot("3-embedded-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await until(async () => (await page.evaluate(() => getComputedStyle(document.querySelector(".md-drawing-picture--region svg")).filter)).includes("invert"));
  const dark = await page.evaluate(() => getComputedStyle(document.querySelector(".md-drawing-picture--region svg")).filter);
  await shot("4-embedded-dark");
  await page.emulateMedia({ colorScheme: "light" });
  info(`dark theme filter: ${dark}`);

  // 3 — write more inside the area on the source page; the embed shows it.
  await goNote(source.id, page.locator(".ink-note"));
  await sheet().waitFor();
  await page.locator(".pagebook path, .pagebook canvas").first().waitFor({ timeout: 20_000 });
  await drag([200, 430], [420, 440]); // the pen is the default tool
  // Saved about a second after the pen lifts: wait until the stored drawing has the second stroke.
  check("the new stroke was saved", await until(async () => ((await storedInk(source.id)) ?? "").includes("strokes") && (await storedStrokes(source.id)) >= 2));
  await goNote(target.id, page.locator(".cm-content", { hasText: "引用一塊" }));
  const more = await until(async () => (await paths()) > before);
  check("a stroke added in the area later shows in the embed", more, `${before} -> ${await paths()}`);

  // 4 — tap the embed: the page opens at the area, marked; back returns to the note.
  await page.locator(".cm-embed .md-drawing-picture--region").first().click();
  await page.locator(".ink-note").first().waitFor({ timeout: 20_000 });
  const marked = await until(async () => (await page.locator("[data-ink-region-mark]").count()) > 0, 8_000);
  check("tapping the embed opens the handwriting page with the area marked", marked);
  await shot("5-opened-at-area");
  await page.goBack();
  const back = await page.locator(".cm-content", { hasText: "引用一塊" }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check("back returns to the note the embed was tapped in", back);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check("no horizontal scrollbar", !overflow);
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("the run finished", false, String(error).slice(0, 300));
  await shot("failed").catch(() => {});
} finally {
  await browser.close();
  site.close();
}
function info(message) { console.log(`INFO  ${message}`); }
const failed = results.filter((ok) => !ok).length;
console.log(`${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${results.length} checks, ${engine})`);
process.exit(failed === 0 ? 0 : 1);

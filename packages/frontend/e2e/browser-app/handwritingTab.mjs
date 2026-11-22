// npm run build:browser (repo root), then: node e2e/browser-app/handwritingTab.mjs [--shots <dir>]
// A plain note's 「手寫」 tab in real Chromium (desktop light, desktop dark, phone with touch): 新增檢視 → 手寫 → draw →
// ＋ 新增一頁 → draw again → 內容 and type → reload → text and both pages' strokes are still there, on the tab and in the
// note's own attribute (note_ink). Taking the tab away and adding it again brings the strokes back; a handwriting note
// (ink_data) still opens as before. Exit code 1 when a check fails.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved, VIEWPORTS } from "../layout-audit/env.mjs";

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

const browser = await launch();
const site = await startSite();
const RUNS = [
  { name: "desktop-light", vp: VIEWPORTS.find((v) => v.id === "1280") },
  { name: "desktop-dark", vp: VIEWPORTS.find((v) => v.id === "1440-dark") },
  { name: "phone", vp: VIEWPORTS.find((v) => v.id === "pixel5") },
];

for (const { name, vp } of RUNS) {
  console.log(`\n== ${name}`);
  const { page } = await openApp(browser, site, vp, { seed: false });
  const NOTE = "00000000-0000-4000-8000-0000000d0001";
  const INK_NOTE = "00000000-0000-4000-8000-0000000d0002";
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
    return r.status === 204 ? null : r.json();
  }, { method, path, body });
  await call("POST", "/api/nodes", { id: NOTE, title: "一般筆記", markdown: "原本的文字" });
  await call("POST", "/api/nodes", { id: INK_NOTE, title: "舊的手寫筆記", markdown: "" });
  await call("PUT", `/api/nodes/${INK_NOTE}/attributes/ink_data`, { value: JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } }), value_type: "text" });
  await waitSaved(page);

  const inkOf = async (id, key) => page.evaluate(async ({ id, key }) => {
    const rows = await (await fetch(`/api/nodes/${id}/attributes?keys=${key}`)).json();
    const value = (Array.isArray(rows) ? rows : []).find((a) => a.key === key)?.value ?? "";
    // The first page is the document itself; the rest are in morePages, one record per page (@onden/markdown/ink noteDoc).
    const doc = value ? JSON.parse(value) : null;
    return { strokes: (value.match(/"points"/g) ?? []).length, pages: doc ? 1 + Object.keys(doc.morePages?.pages ?? {}).length : 0 };
  }, { id, key });
  const until = async (probe, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await page.waitForTimeout(400); } return false; };
  const shot = (label) => shots ? page.screenshot({ path: join(shots, `${name}-${label}.png`) }) : Promise.resolve();
  const open = async (id) => {
    await page.goto(`${site.base}?view=notes&node=${id}&lens=editor`);
    await page.waitForSelector(".obsidian-title-input", { timeout: 60_000 });
    await page.waitForTimeout(1200);
  };
  const tabs = () => page.locator(vp.mobile ? ".phone-view-tabs" : ".view-tabs-bar, .view-tabs").first();
  const draw = async (pageIndex) => {
    const surface = page.locator(".page-ink-surface").nth(pageIndex);
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    const x0 = box.x + box.width * 0.2, y0 = box.y + Math.min(box.height * 0.3, 200);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + i * 14, y0 + Math.sin(i / 2) * 30, { steps: 2 });
    await page.mouse.up();
  };

  await open(NOTE);
  await tabs().getByRole("button", { name: "新增檢視" }).first().click();
  await page.getByRole("menuitem", { name: "手寫" }).first().click().catch(async () => { await page.getByText("手寫", { exact: true }).first().click(); });
  await page.waitForSelector(".page-ink-surface", { timeout: 30_000 });
  check(await tabs().getByRole("tab", { name: "手寫" }).count() === 1, "the 手寫 tab is added to the note");
  check(await page.getByRole("button", { name: "＋ 新增一頁" }).isVisible(), "＋ 新增一頁 is visible under the last page (not in ⋯)");
  await shot("1-tab");

  await draw(0);
  // Paper is white in both themes and strokes keep their stored (light-theme) colours on it: the default pen (#15130d) is
  // near-black on white in the dark theme too, never inverted to near-white.
  const paper = await page.evaluate(() => {
    const sheet = document.querySelector(".pagebook-page");
    const canvases = [...document.querySelectorAll(".page-ink-surface canvas")];
    let drawn = 0, lightest = 0;
    for (const c of canvases) {
      const data = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
      if (!data) continue;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { drawn++; lightest = Math.max(lightest, data[i], data[i + 1], data[i + 2]); }
    }
    return { background: getComputedStyle(sheet).backgroundColor, drawn, lightest };
  });
  check(paper.background === "rgb(255, 255, 255)", `the page's paper is white (${name})`, paper.background);
  check(paper.drawn > 0 && paper.lightest < 90, `the stroke on the paper is near-black (${name})`, JSON.stringify(paper));
  check(await until(async () => (await inkOf(NOTE, "note_ink")).strokes >= 1), "a stroke is saved in the note's note_ink");
  await page.getByRole("button", { name: "＋ 新增一頁" }).click();
  await page.waitForTimeout(600);
  check(await page.locator(".page-ink-surface").count() >= 2, "a second page is added");
  await draw(1);
  check(await until(async () => { const v = await inkOf(NOTE, "note_ink"); return v.strokes >= 2 && v.pages === 2; }), "the second page's stroke is saved too", JSON.stringify(await inkOf(NOTE, "note_ink")));
  await shot("2-two-pages");

  await tabs().getByRole("tab", { name: "內容" }).click();
  const editor = page.locator(".cm-content").first();
  await editor.waitFor({ timeout: 20_000 });
  check((await editor.innerText()).includes("原本的文字") && await page.locator(".page-ink-surface").count() === 0, "內容 is the note's text, not a handwriting page");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" 加上的字");
  await waitSaved(page);
  await shot("3-content");

  await open(NOTE);
  check((await page.locator(".cm-content").first().innerText()).includes("加上的字"), "after a reload the typed text is there");
  await tabs().getByRole("tab", { name: "手寫" }).click();
  await page.waitForSelector(".page-ink-surface", { timeout: 30_000 });
  await page.waitForTimeout(1000);
  const afterReload = await inkOf(NOTE, "note_ink");
  check(afterReload.strokes >= 2 && afterReload.pages >= 2 && await page.locator(".page-ink-surface").count() >= 2, "after a reload both pages and their strokes are there", JSON.stringify(afterReload));
  check((await inkOf(NOTE, "ink_data")).strokes === 0, "the note's content (ink_data) was never turned into a handwriting page");
  await shot("4-after-reload");

  // Taking the tab away keeps the strokes; adding it again shows them.
  const views = (await call("GET", `/api/nodes/${NOTE}/views`)).views;
  await call("DELETE", `/api/nodes/${NOTE}/views/${views.find((v) => v.layout === "handwriting").id}`);
  check((await inkOf(NOTE, "note_ink")).strokes >= 2, "the strokes stay when the tab is taken away");
  await open(NOTE);
  await tabs().getByRole("button", { name: "新增檢視" }).first().click();
  await page.getByRole("menuitem", { name: "手寫" }).first().click().catch(async () => { await page.getByText("手寫", { exact: true }).first().click(); });
  await page.waitForSelector(".page-ink-surface", { timeout: 30_000 });
  check(await page.locator(".page-ink-surface").count() >= 2, "adding the tab again shows both pages");
  // One 手寫 tab per note: 「新增檢視」 opens the existing one.
  await tabs().getByRole("button", { name: "新增檢視" }).first().click();
  await page.getByRole("menuitem", { name: "手寫" }).first().click().catch(async () => { await page.getByText("手寫", { exact: true }).first().click(); });
  await page.waitForTimeout(800);
  check(await tabs().getByRole("tab", { name: "手寫" }).count() === 1, "a note has at most one 手寫 tab");

  // The older handwriting note opens as before.
  await open(INK_NOTE).catch(async () => {});
  await page.waitForSelector(".page-ink-surface", { timeout: 30_000 }).catch(() => {});
  check(await page.locator(".page-ink-surface").count() >= 1, "a handwriting note (ink_data) still opens as its content");
  await shot("5-handwriting-note");
  await page.context().close();
}

await browser.close();
site.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");

// Feature-audit deepening (2026-10-08): FIND-01 — Chinese search in the
// sidebar (local index) and the palette (server): title and body terms,
// empty result, clearing, a slow stale response overtaken by a newer query,
// offline, and a long result list (250 matches).
import { test, type Page } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


test("FIND-01: CJK search, stale results, offline, long list", async ({ page, context }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const tagS = String(stamp).slice(-6);
  const out: Record<string, unknown> = {};
  const mk = (title: string, markdown: string) => page.request.post("/api/nodes", { ...H, data: { title, markdown } });
  await mk(`量子力學筆記${tagS}`, "第一章介紹");
  await mk(`量子電腦${tagS}`, "比特與疊加");
  await mk(`方程式整理${tagS}`, `這裡寫了薛丁格${tagS}方程式的推導`);
  for (let i = 0; i < 250; i += 25) await Promise.all(Array.from({ length: 25 }, (_, k) => mk(`長清單${tagS} 第${i + k}篇`, "內容")));
  const sidebar = async (q: string) => {
    const box = page.getByPlaceholder(/^Search notes \(/);
    if (!(await box.isVisible().catch(() => false))) { await page.keyboard.press("Control+f"); await page.waitForTimeout(300); }
    await box.fill(q); await page.waitForTimeout(1200);
    const rows = await page.locator(".obsidian-page-button, .sb-search-result, [class*=search-result]").filter({ visible: true }).allInnerTexts();
    return { n: rows.filter((r) => r.includes(tagS)).length, sample: rows.filter((r) => r.includes(tagS)).slice(0, 3).map((r) => r.replace(/\s+/g, " ").slice(0, 50)), empty: (await page.locator("text=/No (notes|results|matches)/i").count()) > 0 };
  };
  const palette = async (q: string) => {
    await page.keyboard.press("Escape"); await page.keyboard.press("Control+k");
    await page.locator(".palette-input-wrap input").fill(q); await page.waitForTimeout(1500);
    const rows = await page.locator(".palette-item, [role=option]").allInnerTexts();
    return { n: rows.filter((r) => r.includes(tagS)).length, sample: rows.filter((r) => r.includes(tagS)).slice(0, 2).map((r) => r.replace(/\s+/g, " ").slice(0, 70)), text: (await page.locator(".palette-backdrop").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80) };
  };
  try {
  await ready(page, "/?view=notes"); await page.waitForTimeout(3000);
  out.sidebarTitle = await sidebar(`量子`);
  out.sidebarBody = await sidebar(`薛丁格${tagS}`);
  out.sidebarEmpty = await sidebar(`不存在的詞${tagS}`);
  await page.getByPlaceholder(/^Search notes \(/).fill(""); await page.waitForTimeout(600);
  out.sidebarCleared = (await page.locator(".obsidian-page-button").filter({ visible: true }).count()) > 0;
  out.sidebarLong = await sidebar(`長清單${tagS}`);
  out.paletteTitle = await palette(`量子`);
  out.paletteBody = await palette(`薛丁格${tagS}`);
  out.paletteLong = await palette(`長清單${tagS}`);
  // Stale: first query slow, second fast.
  let first = true;
  await page.route("**/api/nodes/search**", async (r) => { if (first) { first = false; await new Promise((res) => setTimeout(res, 3500)); } return r.continue().catch(() => {}); });
  await page.keyboard.press("Escape"); await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(`量子`); await page.waitForTimeout(400);
  await page.locator(".palette-input-wrap input").fill(`薛丁格${tagS}`); await page.waitForTimeout(5000);
  out.paletteStale = (await page.locator(".palette-item, [role=option]").allInnerTexts()).filter((r) => r.includes(tagS)).map((r) => r.replace(/\s+/g, " ").slice(0, 40));
  await page.unroute("**/api/nodes/search**");
  await page.keyboard.press("Escape");
  // Offline.
  await context.setOffline(true); await page.waitForTimeout(800);
  out.offlineSidebar = await sidebar(`量子`);
  out.offlinePalette = await palette(`量子`);
  await context.setOffline(false);
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("FIND01 " + JSON.stringify(out, null, 2));
  }
});

// Feature-audit deepening (2026-10-08): NAV-07 — sidebar sort options
// (natural / modified / title / created) actually reorder, the choice after
// reopen, long names, drag-to-reorder availability, and keyboard focus moving
// through the virtualised list.
import { test } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


test("NAV-07: sidebar sort, reopen, long names, drag, keyboard focus", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const top = () => page.locator(".obsidian-page-button").first().evaluate((el) => { let p: HTMLElement | null = el.parentElement; while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; if (p) p.scrollTop = 0; }).then(() => page.waitForTimeout(300));
  const rows = async () => { await top(); return page.locator(".obsidian-page-button .sb-item-title").allInnerTexts().then((a) => a.slice(0, 8).map((t) => t.slice(0, 26))); };
  // A long title to inspect.
  await page.request.post("/api/nodes", { ...H, data: { title: `ZZLong ${stamp} ` + "很長的標題".repeat(20) + "Averyveryverylongwordwithoutanyspacesatallthatkeepsgoing", markdown: "x" } });
  await ready(page, "/?view=notes");
  await page.waitForTimeout(1500);
  const sortTo = async (label: RegExp) => {
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    const items = await page.locator(".sidebar-sort-menu-item").allInnerTexts();
    out.sortItems = items.map((s) => s.trim());
    await page.locator(".sidebar-sort-menu-item", { hasText: label }).first().click();
    await page.waitForTimeout(800);
    return rows();
  };
  out.natural = await rows();
  out.title = await sortTo(/title|name|A/i);
  out.modified = await sortTo(/modif|updated|recent/i);
  out.created = await sortTo(/creat/i);
  out.createdEqualsNatural = JSON.stringify(out.created) === JSON.stringify(out.natural);
  await sortTo(/title|name|A/i);
  await page.reload(); await page.waitForTimeout(2500);
  out.afterReload = await rows();
  out.reloadKeptTitleSort = JSON.stringify(out.afterReload) === JSON.stringify(out.title);
  // Long name rendering.
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  await page.locator(".sidebar-sort-menu-item", { hasText: /modif|updated|recent/i }).first().click();
  await page.waitForTimeout(600);
  await top();
  const long = page.locator(".obsidian-page-button", { hasText: `ZZLong ${stamp}` }).first();
  out.longName = await long.evaluate((b) => { const t = b.querySelector(".sb-item-title") as HTMLElement; const r = b.getBoundingClientRect(); return { btnW: Math.round(r.width), btnH: Math.round(r.height), titleOverflow: t.scrollWidth > t.clientWidth, ellipsis: getComputedStyle(t).textOverflow, titleAttr: b.getAttribute("title") ?? t.getAttribute("title"), sidebarSW: (b.closest("aside, nav, .obsidian-sidebar") as HTMLElement | null)?.scrollWidth ?? null }; }).catch(() => null);
  // Drag-to-reorder: is anything draggable?
  out.draggableRows = await page.locator(".obsidian-page-button[draggable=true], .obsidian-page-button >> xpath=ancestor-or-self::*[@draggable='true']").count();
  // Keyboard: focus first row, Tab 25 times, does focus stay inside the list and scroll it?
  await page.locator(".obsidian-page-button").first().focus();
  const seen: string[] = [];
  for (let i = 0; i < 25; i++) { await page.keyboard.press("Tab"); seen.push(await page.evaluate(() => (document.activeElement as HTMLElement)?.className?.toString().slice(0, 30) ?? "")); }
  out.tabClasses = [...new Set(seen)];
  await page.locator(".obsidian-page-button").first().focus();
  await page.keyboard.press("ArrowDown");
  out.arrowDownMoves = await page.evaluate(() => (document.activeElement as HTMLElement)?.className?.toString().slice(0, 40));
  console.log("NAV07 " + JSON.stringify(out, null, 2));
});

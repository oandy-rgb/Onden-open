import { test, expect } from "@playwright/test";
import { phoneNotesHome, ready, seedNodes } from "./helpers";

// Paper cuts from a 390px Android phone: the notes list put four header layers
// before the first note, and a note's sub-notes took two big rows. Written
// without a browser to run it on — the numbers are the intent (first note row
// near the top, one header row, ~40px rows), not measured pixels.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("phone list: one header row, the first note within 200px of the topbar, slim rows", async ({ page }) => {
  const token = `dens-${Date.now()}`;
  await seedNodes(page, 8, { title: (i) => `Density ${token} ${i}`, token });
  // /?view=notes opens the landing note (today's) full screen; the list is one step back.
  await phoneNotesHome(page);

  // No separate "Notes" title strip at the list level.
  await expect(page.locator(".overview-mobile-tabs")).toHaveCount(0);

  const topbar = (await page.locator(".app-topbar").boundingBox())!;
  const firstRow = page.locator(".obsidian-sidebar [data-sb-id] .obsidian-page-button, .obsidian-sidebar .obsidian-group-title").first();
  await expect(firstRow).toBeVisible();
  const row = (await firstRow.boundingBox())!;
  expect(row.y - (topbar.y + topbar.height), "first note row within 200px below the top bar").toBeLessThan(200);
  // ~40px rows (the 44px reach is an invisible ::after).
  expect(row.height).toBeGreaterThanOrEqual(36);
  expect(row.height).toBeLessThanOrEqual(46);

  // Tabs and tools are ONE row: same vertical band.
  const header = page.locator(".obsidian-sidebar-header");
  const tab = (await header.getByRole("button", { name: "Inbox" }).boundingBox())!;
  // A phone's tools are 🔍 ＋ ⋯ (OverviewSidebar: the ⋯ menu holds the order and 全部展開).
  for (const name of ["Search notes", "Create", "More"]) {
    const tool = (await header.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(Math.abs((tool.y + tool.height / 2) - (tab.y + tab.height / 2)), `${name} shares the tabs' row`).toBeLessThan(10);
  }
  await expect(page.locator(".sidebar-sort-bar")).toHaveCount(0);

  // The removed switch, and the kept tag block.
  await expect(page.getByText(/generated items/i)).toHaveCount(0);

  // A touch screen shows no inline trash on the selected row.
  await firstRow.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(".obsidian-delete-btn:visible")).toHaveCount(0);
});

test("a note's sub-notes: ONE header row, slim rows, no view menu or repeated 'table'", async ({ page }) => {
  const token = `kids-${Date.now()}`;
  const [parentId] = await seedNodes(page, 1, { title: () => `Parent ${token}`, token });
  await seedNodes(page, 3, { parentId, title: (i) => `Child ${token} ${i}`, token });
  await ready(page, `/?view=notes&node=${parentId}`);

  // Since 2026-10-31 the sub-notes section is only the list under one heading that folds it
  // (NoteRelations; no view menu, no 「新增檢視」, no settings: src/test/noteChildViews.test.tsx).
  const section = page.locator(".note-relations-children");
  await section.scrollIntoViewIfNeeded();
  const heading = section.getByRole("heading", { name: /Sub-notes|子筆記/ });
  await expect(heading).toBeVisible();
  const h = (await heading.boundingBox())!;
  expect(h.height, "the sub-notes header is one row").toBeLessThan(48);
  await expect(section.locator(".cv-bar, .cv-view-chip")).toHaveCount(0);
  await expect(section.getByRole("button", { name: /View options|檢視選項/ })).toHaveCount(0);
  await expect(section.getByRole("table")).toHaveCount(0);
  await expect(section.getByText(/^(table|Table|表格)$/)).toHaveCount(0);

  // Slim rows, not big cards, inside the phone's width.
  const rows = section.getByRole("button", { name: new RegExp(`^Child ${token} `) });
  await expect(rows).toHaveCount(3);
  for (const box of await Promise.all([0, 1, 2].map((i) => rows.nth(i).boundingBox()))) {
    expect(box!.height).toBeLessThanOrEqual(48);
  }
  expect((await section.boundingBox())!.width).toBeLessThanOrEqual(390);
  // No big dashed quick-add box.
  await expect(section.locator(".cv-quickadd-input-wrap")).toHaveCount(0);
});

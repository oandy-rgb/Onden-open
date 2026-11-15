import { test, expect, type Page } from "@playwright/test";
import { ready, seedNodes, phoneNotesHome, scrollToSidebarRow } from "./helpers";

// Deleting a note must leave the tree where it was: the rows above the deleted
// one do not move, and the focused note hands over to its neighbour.

const rowTop = (page: Page, id: string) =>
  page.locator(`[data-sb-id="${id}"]`).evaluate((el) => el.getBoundingClientRect().top);

async function seedList(page: Page, n: number) {
  const token = `delplace-${Date.now()}`;
  const ids = await seedNodes(page, n, { token, title: (i) => `${token} ${String(i).padStart(4, "0")}` });
  return { ids, token };
}


for (const [label, count] of [["plain list", 60], ["windowed list (>300 rows)", 320]] as const) {
  test(`desktop: deleting a middle note keeps the rows above in place — ${label}`, async ({ page }) => {
    // PRODUCT BUG? (2026-11-01 sweep): on the windowed list the rows above the
    // deleted one move (17px and 186px in two fresh-stack runs; the plain list
    // holds). Needs a look at the windowed path of #999 (delete keeps tree place).
    test.fixme(count > 300, "windowed sidebar: rows above a deleted note move — see #999");
    await page.setViewportSize({ width: 1280, height: 800 });
    const { ids } = await seedList(page, count);
    // Which of the seeded rows is "in the middle" depends on the sort the sidebar shows; read it from the DOM.
    await ready(page, `/?view=notes&node=${ids[Math.floor(count / 2)]}`);
    const target = ids[Math.floor(count / 2)];
    // New notes list after the older ones (lib/childOrder), so on a long list
    // the target is further down than the first window.
    await scrollToSidebarRow(page, target);
    // Centre the row so there are rows above and below it.
    await page.locator(".obsidian-page-list").evaluate((list, id) => {
      const row = list.querySelector(`[data-sb-id="${id}"]`) as HTMLElement;
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2;
    }, target);
    const above = await page.locator(`[data-sb-id="${target}"]`).evaluate((el) => (el.previousElementSibling as HTMLElement | null)?.dataset.sbId ?? null);
    expect(above, "a row above the deleted one").toBeTruthy();
    const before = await rowTop(page, above!);

    await page.locator(`[data-sb-id="${target}"]`).hover();
    await page.locator(`[data-sb-id="${target}"] .obsidian-delete-btn`).click();
    await expect(page.locator(`[data-sb-id="${target}"]`)).toHaveCount(0);
    // Let any scroll the selection handover causes finish before measuring.
    await page.waitForTimeout(600);

    expect(Math.abs((await rowTop(page, above!)) - before)).toBeLessThanOrEqual(2);
    // The neighbour is open and marked in the tree.
    await expect(page.locator(".obsidian-page-button.active")).toHaveCount(1);
  });
}

test("phone: delete from the note's ⋯ menu returns to the list where it was", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { ids } = await seedList(page, 60);
  await phoneNotesHome(page);
  const target = ids[30];
  const row = await scrollToSidebarRow(page, target);
  await page.evaluate(() => window.scrollBy(0, 200));
  const above = await row.evaluate((el) => (el.previousElementSibling as HTMLElement).dataset.sbId!);
  const before = await rowTop(page, above);

  await row.locator(".obsidian-page-button").click();
  await expect(page.locator(".obsidian-title-input")).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

  await expect(page.locator(`[data-sb-id="${above}"]`)).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => Math.abs((await rowTop(page, above)) - before), { timeout: 5_000 }).toBeLessThanOrEqual(2);
  await expect(page.locator(`[data-sb-id="${target}"]`)).toHaveCount(0);
});

test("phone: the ‹ back button returns to the list where it was", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { ids } = await seedList(page, 60);
  await phoneNotesHome(page);
  const row = await scrollToSidebarRow(page, ids[30]);
  await page.evaluate(() => window.scrollBy(0, 200));
  const before = await rowTop(page, ids[30]);

  await row.locator(".obsidian-page-button").click();
  await expect(page.locator(".obsidian-title-input")).toBeVisible();
  await page.locator(".omt-back").click();

  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => Math.abs((await rowTop(page, ids[30])) - before), { timeout: 5_000 }).toBeLessThanOrEqual(2);
});

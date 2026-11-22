import { test, expect } from "@playwright/test";
import { phoneNotesHome, seedNodes } from "./helpers";

// Owner report (2026-10-23): after opening a note from the list, the top-left
// Back must return to the list at the scroll position it was left at (with the
// opened row on screen), not at the top. See lib/pageScrollRestore.ts.
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: Back from a note returns the list to its scroll position", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  await seedNodes(page, 80, { title: (i) => `BackScroll ${String(i).padStart(3, "0")}`, token: `backscroll-${stamp}` });
  // /?view=notes opens the landing note (today's) full screen; the list is one step back.
  await phoneNotesHome(page);

  await expect
    .poll(async () => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
    .toBeGreaterThan(1200);
  // Scroll to the seeded rows themselves, not to a fixed offset: earlier specs leave any number of other notes
  // above them, and at a fixed offset the screen can show only those (no row of ours to open).
  await page.locator("[data-sb-id]").filter({ hasText: /BackScroll/ }).nth(40).evaluate((el) => el.scrollIntoView({ block: "center" }));
  const before = await page.evaluate(() => Math.round(window.scrollY));
  expect(before).toBeGreaterThan(1000);

  // Open a row that is on screen at that scroll position.
  const row = page.locator("[data-sb-id]").filter({ hasText: /BackScroll/ }).evaluateAll((els) => {
    const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.top > 100 && r.bottom < innerHeight - 100; });
    return el?.textContent?.trim().slice(0, 40) ?? "";
  });
  const title = await row;
  expect(title).not.toBe("");
  await page.locator("[data-sb-id]", { hasText: title }).first().click();
  await expect(page.locator(".overview-mobile-tabs .omt-back")).toBeVisible();

  await page.locator(".overview-mobile-tabs .omt-back").click();

  const target = page.locator("[data-sb-id]", { hasText: title }).first();
  await expect(target).toBeInViewport();
  const after = await page.evaluate(() => Math.round(window.scrollY));
  expect(Math.abs(after - before), "list scroll restored").toBeLessThan(40);
});

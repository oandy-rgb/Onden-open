import { test, expect } from "@playwright/test";
import { ready, seedNodes } from "./helpers";

// Regression: the mobile List/Edit/Info sub-tabs must sit flush under the 48px
// fixed topbar — no blank band. .workspace-grid's overflow-x:hidden promoted
// overflow-y to `auto` (scroll-container), so the sticky tabs' top:48 offset
// stacked on top of the grid's own padding-top:48 → a 48px empty band above
// the tabs. Fixed by overflow-x:clip on mobile (clips without making a scroll
// container). Guard the tabs' top position directly.
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: the list header sits flush under the topbar (no blank band)", { tag: "@critical" }, async ({ page }) => {
  await seedNodes(page, 6, { title: (i) => `Flush ${i}`, token: `flush-${Date.now()}` });
  await ready(page, "/?view=notes");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);

  // The list level has no "Notes" strip any more: its own tabs row is the first
  // thing under the 48px topbar. The old band was a second 48px of padding.
  const top = await page.locator(".obsidian-sidebar-header").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(top, "the list's tabs row must sit right under the 48px topbar").toBeLessThanOrEqual(64);
});

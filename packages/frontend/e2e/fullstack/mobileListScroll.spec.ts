import { test, expect } from "@playwright/test";
import { phoneNotesHome, seedNodes } from "./helpers";

// Regression: the List tab's note list must be scrollable on a phone. The
// desktop sidebar makes .obsidian-page-list an overflow-y:auto internal
// scroller; on mobile the sidebar grows to content so the list has no internal
// scroll room, and an overflow-y:auto element with nothing to scroll SWALLOWS
// the touch-drag instead of letting the page scroll under it. The fix lets the
// list overflow (virtualization is off on mobile) so the page scrolls.
// Playwright can't reproduce the touch swallow (programmatic scroll bypasses
// it), so we guard the two invariants that make touch-scroll work: the list is
// NOT a scroll container, and the page itself is scrollable.
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: the List tab note list is scrollable", { tag: "@critical" }, async ({ page }) => {
  await seedNodes(page, 50, { title: (i) => `ListItem ${String(i).padStart(3, "0")}`, token: `listscroll-${Date.now()}` });
  // /?view=notes opens the landing note (today's) full screen; the list is one step back.
  await phoneNotesHome(page);

  // The note list must not be its own (touch-swallowing) scroll container.
  const overflowY = await page.locator(".obsidian-page-list").evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY, "page-list must not be overflow-y:auto/scroll on mobile (it swallows touch)").toBe("visible");

  // …and the page itself must scroll past the first screen so the long list is reachable.
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
    .toBeGreaterThan(800);
  const reached = await page.evaluate(() => { window.scrollTo(0, 1600); return Math.round(window.scrollY); });
  expect(reached, "page must scroll well past the first screen").toBeGreaterThan(1000);
});

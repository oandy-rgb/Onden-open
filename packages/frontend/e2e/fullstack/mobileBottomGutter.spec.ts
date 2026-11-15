import { test, expect } from "@playwright/test";
import { ready, seedNodes } from "./helpers";

// Regression: the fixed bottom nav (MobileNav, position:fixed ~56px) overlays
// the foot of every mode. The workspace reserves a bottom gutter so scrolled
// content clears it — without it the last items of any surface sit UNDER the
// bar, unseen/untappable ("底下都會漏").
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: content clears the fixed bottom nav", { tag: "@critical" }, async ({ page }) => {
  await seedNodes(page, 40, { title: (i) => `Tail ${String(i).padStart(3, "0")}`, token: `gutter-${Date.now()}` });
  await ready(page, "/?view=notes");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);

  const { navTop, lastBottom } = await page.evaluate(() => {
    const nav = document.querySelector(".mobile-bottom-nav") as HTMLElement;
    const rows = document.querySelectorAll(".obsidian-page-button");
    const last = rows[rows.length - 1] as HTMLElement;
    return { navTop: Math.round(nav.getBoundingClientRect().top), lastBottom: Math.round(last.getBoundingClientRect().bottom) };
  });
  // The last row's bottom must sit at or above the nav's top edge (not under it).
  expect(lastBottom, "last item must clear the fixed bottom nav").toBeLessThanOrEqual(navTop);
});

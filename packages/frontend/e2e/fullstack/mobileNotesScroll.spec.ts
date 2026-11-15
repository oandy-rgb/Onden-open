import { test, expect } from "@playwright/test";
import { ready, seedNodes } from "./helpers";

// Regression: a long note must be scrollable on a phone. The desktop editor
// caps .obsidian-main at calc(100vh-48px) and scrolls INTERNALLY; on mobile
// that fixed height made the flex column crush .obsidian-tiptap-wrap
// (overflow:hidden), while CodeMirror's .cm-scroller grows to its content
// (overflow:visible) — so nothing scrolled and the note body below the fold
// was unreachable. Mobile now lets .obsidian-main grow and the PAGE scroll.
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: a long note scrolls to the bottom", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  // ~120 paragraphs so the body far exceeds one phone screen.
  const body = Array.from({ length: 120 }, (_, i) => `Line ${i} — the quick brown fox jumps over the lazy dog.`).join("\n\n");
  const [id] = await seedNodes(page, 1, { title: () => `LongScroll ${stamp}`, markdown: () => body, token: `scroll-${stamp}` });

  await ready(page, `/?view=notes&node=${id}`);
  const editTab = page.locator('.overview-mobile-tabs button', { hasText: /edit/i });
  if (await editTab.count()) await editTab.first().click().catch(() => {});

  // The PAGE (not a crushed inner pane) is the scroll container, and there is a
  // screenful-plus of it to scroll. In the bug .obsidian-main was capped at the
  // viewport height and nothing overflowed it → only ~99px of page scroll.
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
    .toBeGreaterThan(1000);

  // And the page actually scrolls deep — in the bug scrollY saturated at ~99.
  const reached = await page.evaluate(() => {
    window.scrollTo(0, 1800);
    return Math.round(window.scrollY || document.documentElement.scrollTop);
  });
  expect(reached, "page must scroll well past the first screen").toBeGreaterThan(1000);
});

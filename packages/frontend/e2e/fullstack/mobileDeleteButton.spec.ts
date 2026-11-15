import { test, expect } from "@playwright/test";
import { H, ready, scrollToSidebarRow, seedNodes } from "./helpers";

// Regression: the list-row delete button is opacity:0 / :hover-revealed on
// desktop — invisible and untappable on a phone ("刪除鍵沒有用"). A phone must
// still be able to delete a note from the list, and it must actually delete.
// Since 2026-11-02 a touch screen has no inline trash at all (OverviewSidebar.css
// `@media (hover: none)`): delete is in the row's hold menu (useSidebarDrag: held
// still and let go in place opens it). And since 2026-11-07 (#1342) coming back
// from a note highlights no row, so there is no "selected row" to carry a button.
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: a list row's hold menu deletes the note", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const ids = await seedNodes(page, 4, { title: (i) => `Del ${i} ${stamp}`, token: `del-${stamp}` });
  await ready(page, "/?view=notes");
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  await page.locator(".omt-back").click();

  // A busy workspace's phone list is windowed: bring the row into the page first.
  const row = await scrollToSidebarRow(page, ids[1]);
  await expect(row).toContainText(`Del 1 ${stamp}`);
  const box = (await row.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  // A finger held still on the row, then lifted in place (lib/touchHold: 300ms).
  const touch = (type: string, sel?: string) => page.evaluate(({ type, sel, x, y }) => {
    const target = sel ? document.querySelector(sel)! : window;
    target.dispatchEvent(new PointerEvent(type, {
      pointerType: "touch", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
    }));
  }, { type, sel, x, y });
  await touch("pointerdown", `[data-sb-id="${ids[1]}"] .obsidian-page-button`);
  await page.waitForTimeout(450);
  await touch("pointerup");
  // …and the click the browser sends for that touch, at the finger (the menu swallows it).
  await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, cancelable: true })), { x, y });

  const del = page.getByRole("menuitem", { name: /^(Delete|刪除)/ });
  await expect(del, "the row's hold menu offers Delete on a phone").toBeVisible();
  await del.click();
  await expect(page.locator(`[data-sb-id="${ids[1]}"]`)).toHaveCount(0);
  await expect.poll(async () => (await page.request.get(`/api/nodes/${ids[1]}`, H)).status()).toBe(404);
  // Only that note went.
  expect((await page.request.get(`/api/nodes/${ids[2]}`, H)).status()).toBe(200);
});

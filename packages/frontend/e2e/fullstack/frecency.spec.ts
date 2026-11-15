// ⌘K frecency — the palette's default (no-query) list ranks notes by open
// history (frequency × recency), not just updated_at. A note opened recently
// floats above one merely edited recently.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";


async function mk(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}

test("opening a note floats it to the top of the palette's default list", async ({ page }) => {
  const stamp = Date.now();
  // Created A then B then C → by updated_at, C is newest (would lead the list).
  const a = await mk(page, `FreqA ${stamp}`);
  await mk(page, `FreqB ${stamp}`);
  await mk(page, `FreqC ${stamp}`);

  // Open A (its frecency now > 0; C still leads by updated_at otherwise).
  await ready(page, `/?view=notes&node=${a.id}`);
  await page.locator(".cm-content").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400); // let the open-history write settle

  // Open the palette with no query → the Recent Notes group is frecency-ranked.
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette-input-wrap input")).toBeFocused();
  const recent = page.locator(".palette-group", { hasText: "Recent Notes" });
  await expect(recent).toBeVisible({ timeout: 10_000 });
  // A (opened) ranks above C (newest by updated_at) — assert A is the first row.
  await expect(recent.locator(".palette-item-label").first()).toHaveText(`FreqA ${stamp}`);
});

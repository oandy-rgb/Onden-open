import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// The phone History screen (components/history/WorkspaceHistory: 「變更」｜「最近刪除」, which
// replaced the old event log with its Events tab, Refresh button and filter selects). Kept from
// the old screen's guard: a note's quick edits are ONE compact row (one row per note per day),
// Restore is not on the row (it lives in the note's history the row opens), the filter is one
// button (the space filter, in the phone's top bar) opening a choice instead of inline selects,
// and there is no Refresh button. 390x844 viewport, not a real phone.
test.use({ viewport: { width: 390, height: 844 } });


test("mobile history: grouped edits, compact rows, one filter button, no Refresh", async ({ page }) => {
  const title = `Phone history ${Date.now()}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "one\n" } })).json() as { id: string };
  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { title, markdown: "one\ntwo\n" } });
  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { title, markdown: "one\ntwo\nthree\n" } });

  await ready(page, "/?view=timeline");
  await expect(page.getByRole("tab", { name: "Changes", exact: true })).toHaveAttribute("aria-selected", "true");

  // No Refresh button: the list follows the workspace by itself.
  await expect(page.getByRole("button", { name: /^(Refresh|Reload|重新整理)$/ })).toHaveCount(0);

  // The create and both edits of the note are one row (today's), not one row per edit.
  const rows = page.locator(".wh-note-link", { hasText: title });
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  const box = await rows.boundingBox();
  // Three one-line rows of text (title · time, what changed, a sample) and no more.
  expect(box!.height, "a row is compact").toBeLessThanOrEqual(72);

  // Restore is not on the list; filters are not inline selects.
  await expect(page.getByRole("button", { name: /^(Restore|還原)/ })).toHaveCount(0);
  await expect(page.locator("select")).toHaveCount(0);

  // Filters: one button in the top bar opens the choice of spaces.
  await page.getByRole("button", { name: "Filter by space" }).click();
  const menu = page.getByRole("menu", { name: "Show changes from one space" });
  await expect(menu.getByRole("menuitemradio", { name: "All spaces" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Opening the row opens that note's history, where going back (and restoring) lives.
  await rows.click();
  const history = page.getByRole("dialog", { name: "Version history" });
  await expect(history).toBeVisible();
  await expect(history.getByRole("slider", { name: "Move through this note's history" })).toBeVisible();
});

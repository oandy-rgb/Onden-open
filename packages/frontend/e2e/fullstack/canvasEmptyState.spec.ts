// ⑨ canvas onboarding — an empty board used to show only a cryptic
// "double-click or press C" hint. Now it names both ways to add a card AND
// offers a real first action: "Add a note from your library", which opens the
// existing add-note picker. So a new user isn't stuck staring at a blank board.
import { test, expect } from "@playwright/test";
import { ready, H, boardOwnCardsOnly } from "./helpers";


test("an empty board offers an actionable 'add a note' hint", async ({ page }) => {
  const stamp = Date.now();
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `Empty board ${stamp}` } })).json();

  await ready(page, `/?view=notes&node=${canvas.id}`);
  // A board of the person's own cards: blank until they add one.
  await boardOwnCardsOnly(page);
  const hint = page.locator(".canvas-empty-hint");
  await expect(hint).toBeVisible({ timeout: 30_000 });
  await expect(hint).toContainText("add a card");

  // The actionable affordance opens the library picker (was toolbar-only).
  const addBtn = hint.locator(".canvas-empty-add");
  await expect(addBtn).toBeVisible();
  await addBtn.click();
  await expect(page.locator(".canvas-add-popover")).toBeVisible();
});

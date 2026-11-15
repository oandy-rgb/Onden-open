// The whiteboard is a view of a note (migration 138): a board made now is a
// plain note that opens on its whiteboard tab, and a plain note can be given
// the tab from 「＋」 and take cards on its own board. Not run in the authoring
// session (needs the full stack): run with the other fullstack specs.
import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";


test("a new canvas is a plain note that opens on its whiteboard tab, and Content still shows its text", async ({ page }) => {
  const stamp = Date.now();
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `View board ${stamp}` } })).json();
  const node = await (await page.request.get(`/api/nodes/${canvas.id}`, H)).json();
  expect(node.node_type).toBe("content");

  await ready(page, `/?view=notes&node=${canvas.id}`);
  // The board lays the note's sub-notes out by itself (auto tree, c2200098):
  // a new board shows the note as its one card and says it has none yet.
  const board = page.locator(".canvas-tree-note");
  await expect(board).toHaveText("This note has no sub-notes yet. Add one inside the note and it appears here.");
  await expect(page.getByRole("tab", { name: /Canvas|白板/ })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("tab", { name: /Content|內容/ }).click();
  await expect(board).toBeHidden();
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: /Content|內容/ })).toHaveAttribute("aria-selected", "true");
});

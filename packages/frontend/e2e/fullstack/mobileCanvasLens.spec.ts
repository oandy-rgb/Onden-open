import { test, expect } from "@playwright/test";
import { H, ready, seedLayout, seedNodes } from "./helpers";

// Two-axis nav (mobile-nav-two-axis): the drilled-in note's tab row (above the
// title since 2026-11-07) shows the note's views, and Canvas is CONDITIONAL — it
// appears only for a note that has a board (cards on its own board, or a stored
// whiteboard tab: lib/whiteboardNote ownsBoard; sub-notes alone no longer earn
// one), never for a plain note. This is the platform discipline of "top tabs =
// the current subject's views", kept honest (no empty lens).
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: Canvas lens shows only for canvas-capable notes", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const [parent] = await seedNodes(page, 1, { title: () => `HasCanvas ${stamp}`, token: `clp-${stamp}` });
  const children = await seedNodes(page, 3, { parentId: parent, title: (i) => `Child ${i} ${stamp}`, token: `clc-${stamp}` });
  // Cards on the parent's own board: that is what earns it the Canvas tab.
  const placed = await seedLayout(page.request, parent, { ...H, data: { data: {
    nodes: children.map((nodeId, i) => ({ nodeId, x: 80 + i * 280, y: 80, width: 240 })), edges: [],
  } } });
  expect(placed.ok(), "seed the parent's board").toBe(true);
  const [plain] = await seedNodes(page, 1, { title: () => `PlainNote ${stamp}`, token: `cln-${stamp}` });

  // Open each note directly: a busy workspace's windowed phone list may not
  // render a fresh note without scrolling, and the list is not under test.
  // The parent (earns a canvas) → Canvas lens present + switchable.
  await ready(page, `/?view=notes&node=${parent}`);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  const canvasLens = page.getByRole("tab", { name: "Canvas" });
  await expect(canvasLens).toBeVisible();
  await canvasLens.click();
  // A phone's board is always full screen (#1264): the tab row and top bar give way to the board, and its
  // title ⌄ opens the one sheet with the page's tabs (Canvas selected) and the note's ⊟ ⋯ (no Note | Info switch).
  await expect(page.locator(".react-flow").first()).toBeVisible();
  await page.locator(".board-note-title").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  await expect(sheet.locator(".note-tab-actions").getByTitle("More actions")).toBeVisible();

  // Drill into a plain note → NO Canvas lens (don't show an empty view).
  await ready(page, `/?view=notes&node=${plain}`);
  await expect(page.getByRole("tab", { name: "Content" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Canvas" })).toHaveCount(0);
  await expect(page.locator(".omt-back")).toBeVisible();
});

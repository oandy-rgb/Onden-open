import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";

// Behaviour-driven journeys over the CANVAS (ReactFlow / Heptabase-style). Drive
// real click/keyboard interactions and API setup — NO fragile ReactFlow drag.
// Per-test stamp keeps canvas/node titles unique on the shared DB.

async function makeNode(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}

// Create a canvas and place the given nodes on it (API — no drag).
async function makeCanvas(page: Page, title: string, entries: Array<{ nodeId: string; x: number; y: number }>) {
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: { nodes: entries.map((e) => ({ ...e, width: 240 })), edges: [] } } });
  return canvas as { id: string; title: string };
}

// Canvas-in-Editor (top-bar collapse P2): a board opens by FOCUSING its node
// — no canvas lens, no tab strip. Single-board navigation is the URL/sidebar.
async function openCanvas(page: Page, canvasId: string) {
  await ready(page, `/?view=notes&node=${canvasId}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
}

// 1 — A canvas renders the cards placed on it.
test("a canvas renders the cards placed on it", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `Card A ${stamp}`);
  const b = await makeNode(page, `Card B ${stamp}`);
  const c = await makeNode(page, `Card C ${stamp}`);
  // Stack them on the LEFT (the right inspector narrows the pane) so none get
  // viewport-culled; poll, since ReactFlow renders incrementally.
  const cv = await makeCanvas(page, `Render ${stamp}`, [
    { nodeId: a.id, x: 40, y: 40 }, { nodeId: b.id, x: 40, y: 220 }, { nodeId: c.id, x: 40, y: 400 },
  ]);
  await openCanvas(page, cv.id);
  await expect.poll(() => page.locator(".react-flow__node").count()).toBeGreaterThanOrEqual(3);
});

// 2 — Clicking a card selects it.
test("clicking a card selects it", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `Sel ${stamp}`);
  const cv = await makeCanvas(page, `Select ${stamp}`, [{ nodeId: a.id, x: 60, y: 60 }]);
  await openCanvas(page, cv.id);
  await page.locator(".react-flow__node").first().click();
  await expect(page.locator(".card-node--selected")).toHaveCount(1);
});

// 3 — Create a sub-canvas from a card → breadcrumb appears → back returns.
test("sub-canvas create shows a back breadcrumb and back returns", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `Parent ${stamp}`);
  const cv = await makeCanvas(page, `Sub ${stamp}`, [{ nodeId: a.id, x: 60, y: 60 }]);
  await openCanvas(page, cv.id);

  await page.locator(".react-flow__node").first().click();        // select → reveals the create button
  await page.locator(".card-node-subcanvas-btn--create").click(); // create + descend into the sub-canvas
  await expect(page.locator(".canvas-back-pill")).toBeVisible();   // nested → breadcrumb shows

  await page.locator(".canvas-back-pill").click();
  await expect(page.locator(".canvas-back-pill")).toHaveCount(0);  // back at the parent canvas
});

// 4 — Focusing another canvas node switches the active board (tabs retired).
test("focusing another canvas node switches the active board", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `T1 ${stamp}`);
  const b = await makeNode(page, `T2 ${stamp}`);
  const one = await makeCanvas(page, `One ${stamp}`, [{ nodeId: a.id, x: 60, y: 60 }]);
  const two = await makeCanvas(page, `Two ${stamp}`, [{ nodeId: b.id, x: 60, y: 60 }]);
  await openCanvas(page, two.id);
  await expect(page.locator(".react-flow__node", { hasText: `T2 ${stamp}` })).toBeVisible();
  await openCanvas(page, one.id);
  await expect(page.locator(".react-flow__node", { hasText: `T1 ${stamp}` })).toBeVisible();
});

// 5 — Removing a card from the canvas (context menu) drops it from the board.
test("remove from canvas drops the card", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `Keep ${stamp}`);
  const b = await makeNode(page, `Drop ${stamp}`);
  const canvas = await makeCanvas(page, `Remove ${stamp}`, [
    { nodeId: a.id, x: 40, y: 40 }, { nodeId: b.id, x: 40, y: 260 },
  ]);
  await openCanvas(page, canvas.id);
  await expect(page.locator(".react-flow__node")).toHaveCount(2); // both on the left, retrying

  await page.locator(".react-flow__node").first().click({ button: "right" });
  await page.locator(".ctx-menu", { hasText: "Remove from canvas" }).getByText("Remove from canvas").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  // The card disappears optimistically; wait for server acceptance, then
  // open the board afresh to prove it was not merely removed from the current
  // viewport. (Right-clicking selected the card's note, so a plain reload
  // would reopen that note, not the board.)
  await expect.poll(async () => {
    const fresh = await (await page.request.get(`/api/canvases/${canvas.id}`)).json();
    return fresh.data.nodes.length;
  }).toBe(1);
  await openCanvas(page, canvas.id);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});

// P0-5 canvas undo + 縮放定位: ⌘Z restores a dragged card's position; the
// canvas viewport (zoom/pan) survives switching away and back.
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";


async function makeNode(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}
async function makeCanvas(page: Page, title: string, entries: Array<{ nodeId: string; x: number; y: number }>) {
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: { nodes: entries.map((e) => ({ ...e, width: 240 })), edges: [] } } });
  return canvas as { id: string };
}
async function openCanvas(page: Page, canvasId: string) {
  await ready(page, `/?view=notes&node=${canvasId}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
}

// NB: the ⌘Z undo STACK is covered by unit tests (useCanvasUndo.test.tsx) —
// simulating a ReactFlow mouse drag is explicitly avoided in this suite
// ("NO fragile ReactFlow drag", canvasInteractions.spec.ts).

test("canvas viewport (zoom/pan) survives switching away and back", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `VpCard ${stamp}`);
  const other = await makeNode(page, `VpOther ${stamp}`);
  const cv = await makeCanvas(page, `Viewport ${stamp}`, [{ nodeId: a.id, x: 60, y: 60 }]);
  await openCanvas(page, cv.id);

  // Zoom OUT twice via the controls (zoom-in is disabled at fitView's max
  // zoom for a single card; out is always available).
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  // wait for the viewport stash to be written on move-end
  await expect.poll(() =>
    page.evaluate((id) => window.sessionStorage.getItem(`onden.canvasViewport.${id}`), cv.id),
  ).not.toBeNull();
  const stashed = await page.evaluate((id) => window.sessionStorage.getItem(`onden.canvasViewport.${id}`), cv.id);
  const zoomBefore = (JSON.parse(stashed!) as { zoom: number }).zoom;

  // Switch to a plain note, then back to the canvas.
  await ready(page, `/?view=notes&node=${other.id}`);
  await page.locator(".cm-content").waitFor();
  await openCanvas(page, cv.id);

  // The restored viewport matches the stash (a re-fit would land elsewhere).
  await expect.poll(async () =>
    page.evaluate(() => {
      const vp = document.querySelector(".react-flow__viewport") as HTMLElement | null;
      const m = vp?.style.transform.match(/scale\(([\d.]+)\)/);
      return m ? Number(m[1]) : 0;
    }),
  ).toBeCloseTo(zoomBefore, 1);
});

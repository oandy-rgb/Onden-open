// ⑦ multi-select align/distribute: select cards (click + ⌘-click), the
// floating bar appears, align-left snaps xs together and distribute-vertical
// evenly spaces ys — persisted in ONE batched canvas write (per-node saves
// raced and lost moves).
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";


async function makeNode(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}

test("board: align-left + distribute-vertical via the multi-select bar", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `Al-A ${stamp}`);
  const b = await makeNode(page, `Al-B ${stamp}`);
  const c = await makeNode(page, `Al-C ${stamp}`);
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `AlignBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: {
    nodes: [
      { nodeId: a.id, x: 100, y: 100, width: 240 },
      { nodeId: b.id, x: 320, y: 260, width: 240 },
      { nodeId: c.id, x: 540, y: 500, width: 240 },
    ], edges: [],
  } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 30_000 });

  // Cards by id, not by text: a card's text can be its title input's value only
  // (in a workspace past 2000 notes the store holds no bodies, lib/slimMode).
  // multi-select: click the first card, ⌘-click the rest
  await page.locator(`.react-flow__node[data-id="${a.id}"]`).click();
  await page.locator(`.react-flow__node[data-id="${b.id}"]`).click({ modifiers: ["Meta"] });
  await page.locator(`.react-flow__node[data-id="${c.id}"]`).click({ modifiers: ["Meta"] });
  const bar = page.locator(".canvas-align-bar");
  await expect(bar).toBeVisible();

  await bar.locator('button[title="Align left"]').click();
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const xs = (saved.data.nodes as Array<{ x: number }>).map((n) => n.x);
    return new Set(xs).size;
  }, { timeout: 10_000 }).toBe(1); // all snapped to the same left edge

  await bar.locator('button[title="Distribute vertically"]').click();
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const rows = (saved.data.nodes as Array<{ nodeId: string; y: number }>);
    const ys = rows.map((n) => n.y).sort((p, q) => p - q);
    const g1 = ys[1] - ys[0], g2 = ys[2] - ys[1];
    return Math.abs(g1 - g2) <= 2; // even gaps (rounding tolerance)
  }, { timeout: 10_000 }).toBe(true);

  // ⌘Z undoes the LAST aligned move (the stack got every change)
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const rows = (saved.data.nodes as Array<{ y: number }>);
    const ys = rows.map((n) => n.y).sort((p, q) => p - q);
    const g1 = ys[1] - ys[0], g2 = ys[2] - ys[1];
    return Math.abs(g1 - g2) > 2; // no longer evenly spaced — one move reverted
  }, { timeout: 10_000 }).toBe(true);
});

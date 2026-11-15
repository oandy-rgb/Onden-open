// ⑨ card colour = meaning: colour the whole multi-selection at once from the
// align bar (previously colour lived only in the right-click menu, one card at
// a time — undiscoverable). Select cards → click a swatch → all get the hex,
// persisted in one batched canvas write.
import { test, expect, type Page } from "@playwright/test";
import { seedLayout, H } from "./helpers";


const makeNode = (page: Page, title: string) =>
  page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } }).then((r) => r.json());

test("the align bar colours every selected card in one write", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `Col-A ${stamp}`);
  const b = await makeNode(page, `Col-B ${stamp}`);
  const c = await makeNode(page, `Col-C ${stamp}`);
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `ColorBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: {
    nodes: [
      { nodeId: a.id, x: 100, y: 100, width: 240 },
      { nodeId: b.id, x: 360, y: 120, width: 240 },
      { nodeId: c.id, x: 200, y: 360, width: 240 },
    ], edges: [],
  } } });

  await page.goto(`/?view=notes&node=${canvas.id}`, { waitUntil: "load" });
  await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 30_000 });

  // Cards by id, not by text: a card's text can be its title input's value only
  // (in a workspace past 2000 notes the store holds no bodies, lib/slimMode).
  // Select A + B (leave C uncoloured as the control).
  await page.locator(`.react-flow__node[data-id="${a.id}"]`).click();
  await page.locator(`.react-flow__node[data-id="${b.id}"]`).click({ modifiers: ["Meta"] });
  const bar = page.locator(".canvas-align-bar");
  await expect(bar).toBeVisible();

  // The swatches are discoverable here now (not just the right-click menu).
  await bar.locator('button[title="Blue"]').click();
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const byId = new Map((saved.data.nodes as Array<{ nodeId: string; color?: string }>).map((n) => [n.nodeId, n.color]));
    return [byId.get(a.id), byId.get(b.id), byId.get(c.id)];
  }, { timeout: 10_000 }).toEqual(["#3b82f6", "#3b82f6", undefined]); // A+B blue, C untouched

  // Clearing colour returns them to default.
  await page.locator(`.react-flow__node[data-id="${a.id}"]`).click();
  await page.locator(`.react-flow__node[data-id="${b.id}"]`).click({ modifiers: ["Meta"] });
  await bar.locator('button[title="Clear colour"]').click();
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const byId = new Map((saved.data.nodes as Array<{ nodeId: string; color?: string }>).map((n) => [n.nodeId, n.color]));
    return [byId.get(a.id), byId.get(b.id)];
  }, { timeout: 10_000 }).toEqual([undefined, undefined]);
});

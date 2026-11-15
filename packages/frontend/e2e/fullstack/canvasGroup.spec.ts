// ⑦ 群組框: "Group selection" frames the multi-selected cards with a new
// section (bounding rect + padding). The carry rule (dragging a section
// moves its member cards) is unit-tested in sectionCarry.test.ts — RF drags
// are deliberately not simulated here ("NO fragile ReactFlow drag").
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";


async function makeNode(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}

test("board: Group selection wraps the selected cards in a section", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `Gr-A ${stamp}`);
  const b = await makeNode(page, `Gr-B ${stamp}`);
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `GroupBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: {
    nodes: [
      { nodeId: a.id, x: 100, y: 100, width: 240 },
      { nodeId: b.id, x: 520, y: 360, width: 240 },
    ], edges: [],
  } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2, { timeout: 30_000 });

  // Cards by id, not by text: a card's text can be its title input's value only
  // (in a workspace past 2000 notes the store holds no bodies, lib/slimMode).
  await page.locator(`.react-flow__node[data-id="${a.id}"]`).click();
  await page.locator(`.react-flow__node[data-id="${b.id}"]`).click({ modifiers: ["Meta"] });
  await page.locator('.canvas-align-bar button[title="Group selection"]').click();

  // persisted: one section bounding both cards (padding 40, +24 title room)
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    return (saved.data.sections ?? []).length;
  }, { timeout: 10_000 }).toBe(1);
  const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
  const s = saved.data.sections[0];
  expect(s.x).toBeLessThanOrEqual(100);
  expect(s.y).toBeLessThanOrEqual(100);
  expect(s.x + s.width).toBeGreaterThanOrEqual(520 + 240);
  expect(s.y + s.height).toBeGreaterThanOrEqual(360 + 120);

  // and it renders as a section node on the board
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
});

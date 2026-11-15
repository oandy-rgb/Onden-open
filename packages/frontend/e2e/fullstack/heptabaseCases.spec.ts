// ⑨ Whiteboard acceptance — the Heptabase 10-cases survey
// (youtu.be/z-Q2YnvBN0c) walked on the Onden canvas as ONE knowledge-map
// braid: the primitives those cases lean on (cards on a board, semantic
// color coding, clustering into sections, a visual/reference card, tidy
// arrangement) exercised TOGETHER and asserted, with the one genuine gap —
// timeline-by-date arrangement (the 歷史時間軸 case) — RECORDED, not failed
// ([[verify-like-a-user]]; the spec is the deliverable per ⑨).
//
// Maps to the cases: 功能框架/問題拆解 = cards + clustering; 器官結構標記 =
// color coding; 藏書/旅遊 = a reference (web-embed) card; 歷史時間軸 = the gap.
// Per-primitive coverage already lives in canvasGroup/canvasWebEmbed/etc;
// this braid is the use-case-level integration (color+section+embed on ONE
// persisted board).
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, boardMoreItem, H } from "./helpers";


async function makeNode(page: Page, title: string, markdown: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json();
}

test("Heptabase cases: a knowledge map (cards + color + section + reference card)", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();

  // 問題拆解: a root concept + two sub-parts, plus a reference card whose body
  // is a bare URL (藏書/旅遊 — a visual reference embedded on the board).
  const root = await makeNode(page, `Heart ${stamp}`, "the pump");
  const partA = await makeNode(page, `Atrium ${stamp}`, "upper chamber");
  const partB = await makeNode(page, `Ventricle ${stamp}`, "lower chamber");
  const ref = await makeNode(page, `Ref ${stamp}`, "https://example.com");
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `AnatomyBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: {
    nodes: [
      { nodeId: root.id, x: 100, y: 100, width: 240 },
      { nodeId: partA.id, x: 480, y: 80, width: 240 },
      { nodeId: partB.id, x: 480, y: 320, width: 240 },
      { nodeId: ref.id, x: 900, y: 100, width: 260 },
    ], edges: [],
  } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(4, { timeout: 30_000 });

  // 器官結構標記 (semantic color coding): right-click a sub-part card → Red.
  // (Use Atrium — the root at x=100 sits under the floating toolbar after
  // fitView; the sub-parts are clear of it.)
  await page.locator(`.react-flow__node[data-id="${partA.id}"]`).click({ button: "right" });
  await page.locator('.ctx-menu .ctx-color-swatch[title="Red"]').click();
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    return (saved.data.nodes as Array<{ nodeId: string; color?: string }>).find((n) => n.nodeId === partA.id)?.color;
  }, { timeout: 10_000 }).toBe("#ef4444");

  // 任務拆解/功能框架 (clustering): frame the two sub-parts in a section.
  await page.locator(`.react-flow__node[data-id="${partA.id}"]`).click();
  await page.locator(`.react-flow__node[data-id="${partB.id}"]`).click({ modifiers: ["Meta"] });
  await page.locator('.canvas-align-bar button[title="Group selection"]').click();
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    return (saved.data.sections ?? []).length;
  }, { timeout: 10_000 }).toBe(1);
  const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
  const section = saved.data.sections[0];
  // the section frames both sub-parts (x in [480,720], y in [80,440])
  expect(section.x).toBeLessThanOrEqual(480);
  expect(section.x + section.width).toBeGreaterThanOrEqual(480 + 240);
  expect(section.y + section.height).toBeGreaterThanOrEqual(320 + 120);

  // 藏書/旅遊 (a reference card): the bare-URL note renders as a web embed.
  const embed = page.locator(`.react-flow__node[data-id="${ref.id}"] .card-node-webembed`);
  await expect(embed.locator(".card-node-webembed-bar")).toContainText("example.com");

  // 整理排版 (arrange): Tidy grid repositions the cards (reading order grid).
  const before = (await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json()).data.nodes
    .find((n: { nodeId: string }) => n.nodeId === ref.id);
  await (await boardMoreItem(page, "Tidy up (grid)")).click();
  await expect.poll(async () => {
    const after = (await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json()).data.nodes
      .find((n: { nodeId: string }) => n.nodeId === ref.id);
    return after.x !== before.x || after.y !== before.y;
  }, { timeout: 10_000 }).toBe(true);

  // 歷史時間軸 (RECORDED GAP): no chronological/by-date board arrangement.
  // Onden has Tidy (grid) + Arrange-as-tree, but no "lay cards along a time
  // axis" layout — the one Heptabase case the canvas doesn't cover yet.
  const timelineBtn = page.getByRole("toolbar", { name: "Board tools" }).getByRole("button", { name: /time|date/i });
  if (await timelineBtn.count() === 0) {
    test.info().annotations.push({
      type: "gap",
      description: "Heptabase 歷史時間軸: no by-date/timeline board arrangement on canvas (only Tidy grid + Arrange-as-tree). Candidate: arrangeByTime layout sorting cards along a horizontal axis by created_at/date attr.",
    });
  }
});

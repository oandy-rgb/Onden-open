// ⑦ auto-arrange: tidy (3-col grid) gets a toolbar entry (it was command-
// palette-only) and the bulk re-layout is now ⌘Z-undoable — every card's
// prior position lands on the stack before the move.
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, boardMoreItem, H } from "./helpers";


async function makeNode(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}

test("board: toolbar Tidy snaps cards to the grid; ⌘Z restores", async ({ page }) => {
  const stamp = Date.now();
  const ids: string[] = [];
  for (const n of ["Ta", "Tb", "Tc", "Td"]) ids.push((await makeNode(page, `${n} ${stamp}`)).id);
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `TidyBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: {
    nodes: [
      { nodeId: ids[0], x: 37, y: 911, width: 240 },
      { nodeId: ids[1], x: 503, y: 222, width: 240 },
      { nodeId: ids[2], x: 1244, y: 555, width: 240 },
      { nodeId: ids[3], x: 12, y: 13, width: 240 },
    ], edges: [],
  } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(4, { timeout: 30_000 });

  await (await boardMoreItem(page, "Tidy up (grid)")).click();

  // grid: xs ∈ {80, 440, 800} (280w + 80 gap), ys row-paced — assert via API
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const xs = (saved.data.nodes as Array<{ x: number }>).map((n) => n.x).sort((a, b) => a - b);
    return xs.every((x) => [80, 440, 800].includes(x));
  }, { timeout: 10_000 }).toBe(true);

  // the bulk move is undoable — focus stays on the toolbar button (a plain
  // button, not a text field, so the undo handler's input guard passes)
  await page.keyboard.press("Control+z");
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const rows = saved.data.nodes as Array<{ x: number; y: number }>;
    return rows.some((n) => !([80, 440, 800].includes(n.x)));
  }, { timeout: 10_000 }).toBe(true);
});

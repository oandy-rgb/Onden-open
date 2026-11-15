// ⑦ add-to-board entry: the canvas toolbar's "Add existing note" picker —
// the ONLY way (since the dead aside) to place an existing note on a board,
// and it works the same with a mouse or a finger. Pinned: open board →
// picker → search → click → the note lands as a real card at the spawn
// position; already-on-board notes don't appear in the list.
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";


async function makeNode(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}

test("board: Add-existing-note picker places a note as a card", async ({ page }) => {
  const stamp = Date.now();
  const seed = await makeNode(page, `AddSeed ${stamp}`);
  const target = await makeNode(page, `AddTarget ${stamp}`);
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `AddBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: { nodes: [{ nodeId: seed.id, x: 80, y: 80, width: 240 }], edges: [] } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });

  await page.locator('button[title="Add existing note"]').click();
  const popover = page.locator(".canvas-add-popover");
  await expect(popover).toBeVisible();

  // the seed card is already on the board — it must NOT be offered
  await popover.locator("input").fill(`AddSeed ${stamp}`);
  await expect(popover.getByText("No notes match")).toBeVisible(); // the shared EmptyState (dup-b3)

  // the target is offered; clicking it lands a card
  await popover.locator("input").fill(`AddTarget ${stamp}`);
  await popover.locator(".canvas-add-item", { hasText: `AddTarget ${stamp}` }).click();
  await expect(page.locator(`.react-flow__node:has-text("AddTarget ${stamp}")`)).toBeVisible({ timeout: 15_000 });

  // The card appears optimistically; wait for server acceptance before
  // claiming it survived beyond this browser state.
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    return (saved.data.nodes as Array<{ nodeId: string }>).some((n) => n.nodeId === target.id);
  }).toBe(true);
  // Clicking the card can navigate to the note, so return to the board.
  await ready(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(`.react-flow__node:has-text("AddTarget ${stamp}")`)).toBeVisible();
});

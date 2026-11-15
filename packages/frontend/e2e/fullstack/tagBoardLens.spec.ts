// A tag's canvas lens: the tag's members laid out as cards (routes/boards.ts,
// lib/boardLayout.ts). Members appear without being placed, follow tagging
// done elsewhere, and a save only sends the cards it changed — a card another
// device placed meanwhile survives (GAP-178).
import { test, expect, type Page } from "@playwright/test";
import { H } from "./helpers";


const makeNode = (page: Page, title: string) =>
  page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } }).then((r) => r.json());
const tagNode = (page: Page, nodeId: string, tagId: string) =>
  page.request.put(`/api/nodes/${nodeId}/tags/${tagId}`, H);
const board = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/boards/${id}`, H)).json()) as { cards: Array<{ nodeId: string; x: number; y: number }> };

test("a tag's canvas lens lays out its members and saves only what changed", async ({ page }) => {
  const stamp = Date.now();
  const a = await makeNode(page, `TB-A ${stamp}`);
  const b = await makeNode(page, `TB-B ${stamp}`);
  const c = await makeNode(page, `TB-C ${stamp}`);
  const tag = await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `tagboard${stamp}` } })).json();
  const tagId = tag.leaf_id as string;
  expect((await tagNode(page, a.id, tagId)).ok()).toBeTruthy();
  expect((await tagNode(page, b.id, tagId)).ok()).toBeTruthy();
  // A has a stored place; B has none yet.
  expect((await page.request.patch(`/api/boards/${tagId}`, { ...H, data: { cards: { upsert: [{ nodeId: a.id, x: 100, y: 100, width: 240 }] } } })).ok()).toBeTruthy();

  await page.goto(`/?view=notes&node=${tagId}&lens=canvas`, { waitUntil: "load" });
  const card = (title: string) => page.locator(`.react-flow__node:has-text("${title}")`);
  await expect(card(`TB-A ${stamp}`)).toBeVisible({ timeout: 30_000 });
  await expect(card(`TB-B ${stamp}`)).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  // A tag board has no ink (ink lives on a canvas node).
  await expect(page.locator('button[title^="Draw ink"]')).toHaveCount(0);

  // Another device places C on the board while this page holds an older copy.
  expect((await tagNode(page, c.id, tagId)).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/boards/${tagId}`, { ...H, data: { cards: { upsert: [{ nodeId: c.id, x: 900, y: 900 }] } } })).ok()).toBeTruthy();

  // Drag B: it gets a stored place, and nothing else is rewritten.
  const box = (await card(`TB-B ${stamp}`).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 74, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await board(page, tagId)).cards.some((x) => x.nodeId === b.id), { timeout: 10_000 }).toBe(true);
  const saved = await board(page, tagId);
  expect(saved.cards.find((x) => x.nodeId === a.id)).toMatchObject({ x: 100, y: 100 });
  expect(saved.cards.find((x) => x.nodeId === c.id)).toMatchObject({ x: 900, y: 900 });

  // The newly tagged C shows up once this page syncs.
  await expect(card(`TB-C ${stamp}`)).toBeVisible({ timeout: 20_000 });

  // Untagging elsewhere takes the card off the board; its place is kept.
  expect((await page.request.delete(`/api/nodes/${a.id}/tags/${tagId}`, H)).ok()).toBeTruthy();
  await expect(card(`TB-A ${stamp}`)).toHaveCount(0, { timeout: 20_000 });
  const row = await page.request.get(`/api/boards/${tagId}`, H);
  expect(((await row.json()).cards as Array<{ nodeId: string }>).some((x) => x.nodeId === a.id)).toBe(true);
});

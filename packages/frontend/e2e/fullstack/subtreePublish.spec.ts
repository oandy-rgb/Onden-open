import { test, expect, type Page } from "@playwright/test";
import { ready, openPublishRow, publishFromInfoPanel, defaultSpaceId, publishSite, H } from "./helpers";

// "+ subtree" one-click publish (Notion子樹一鍵發布 parity): publishing a
// parent note from the info panel can cascade `_published` to every descendant
// in one action, instead of toggling each page by hand. Guards the D9 opt-in
// invariant still holds — only the chosen subtree is opted in.

async function siteIds(page: Page): Promise<Set<string>> {
  const s = await (await page.request.get("/api/site")).json();
  return new Set((s.payload?.nodes ?? s.nodes ?? []).map((n: { id: string }) => n.id));
}

test("'+ subtree' cascades publish to every descendant of the note", async ({ page }) => {
  const stamp = Date.now();
  const parent = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Tree ${stamp}`, markdown: "root" } })).json();
  const child = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Child ${stamp}`, markdown: "c", parent_id: parent.id } })).json();
  const grandchild = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Grand ${stamp}`, markdown: "g", parent_id: child.id } })).json();
  // A sibling OUTSIDE the subtree must stay private.
  const outsider = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Outsider ${stamp}`, markdown: "o" } })).json();

  await ready(page, `/?view=notes&node=${parent.id}`);
  await page.waitForTimeout(1000);

  // The subtree button only appears when the note has descendants (count = 2).
  // It lives in the info panel's 「網站」 row, which a note has once it is marked (功能 › Also usable here › Website).
  await publishFromInfoPanel(page);
  const { unpublish, subtree } = await openPublishRow(page);
  await expect(subtree).toBeVisible();
  await subtree.click();
  // The cascade only opts the subtree in; the site serves it after a publish
  // (snapshot model B). The cascade lands asynchronously, so publish until
  // every subtree node is on the served site.
  await expect.poll(async () => {
    await publishSite(page.request);
    const ids = await siteIds(page);
    return [parent.id, child.id, grandchild.id].every((id) => ids.has(id));
  }, { timeout: 20_000, intervals: [1_000] }).toBe(true);
  expect((await siteIds(page)).has(outsider.id)).toBe(false);

  // The parent's own row shows it as marked after the cascade.
  await expect(unpublish).toBeVisible();
});

test("'+ subtree' is absent for a leaf note (no descendants)", async ({ page }) => {
  const stamp = Date.now();
  const leaf = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Leaf ${stamp}`, markdown: "x" } })).json();
  await ready(page, `/?view=notes&node=${leaf.id}`);
  await page.waitForTimeout(1000);
  await publishFromInfoPanel(page);
  const { unpublish, subtree } = await openPublishRow(page);
  await expect(unpublish).toBeVisible();
  await expect(subtree).toHaveCount(0);
});

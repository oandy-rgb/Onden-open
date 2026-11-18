import { test, expect, type Page } from "@playwright/test";
import { ready, openPublishRow, defaultSpaceId, createPublishingSpace, publishSite, H } from "./helpers";

// The subtree and the site (Notion 子樹一鍵發布 parity). Since 2026-11-10 (211dda77) a space that publishes puts every
// note in it on the site, so there is no "+ subtree" opt-in to press; the subtree question moved to the other side:
// 「不發布這則」 on a note with notes under it asks whether to keep those off too (PublishNoteRow). Guards that the
// choice cascades to the chosen subtree only, and that a leaf is kept off without a question.

async function siteIds(page: Page): Promise<Set<string>> {
  const s = await (await page.request.get("/api/site")).json();
  return new Set((s.payload?.nodes ?? s.nodes ?? []).map((n: { id: string }) => n.id));
}

async function mk(page: Page, space_id: string, title: string, parent_id?: string): Promise<{ id: string }> {
  return (await page.request.post("/api/nodes", { ...H, data: { space_id, title, markdown: title, ...(parent_id ? { parent_id } : {}) } })).json();
}

test("keeping a note off with 'Keep them all off' takes every note under it off, and only those", async ({ page }) => {
  const stamp = Date.now();
  const site = await createPublishingSpace(page.request);
  const parent = await mk(page, site, `Tree ${stamp}`);
  const child = await mk(page, site, `Child ${stamp}`, parent.id);
  const grandchild = await mk(page, site, `Grand ${stamp}`, child.id);
  // A sibling outside the subtree stays on the site; a note in the default space (which does not publish) never is.
  const sibling = await mk(page, site, `Sibling ${stamp}`);
  const outsider = await mk(page, await defaultSpaceId(page.request), `Outsider ${stamp}`);

  // Everything in the publishing space is on the next publish without any marking.
  await publishSite(page.request);
  const before = await siteIds(page);
  expect([parent, child, grandchild, sibling].every((n) => before.has(n.id))).toBe(true);
  expect(before.has(outsider.id)).toBe(false);

  await ready(page, `/?view=notes&node=${parent.id}`);
  const { row, unpublish } = await openPublishRow(page);
  await unpublish.click();
  const ask = row.getByRole("group", { name: /Notes under this one|這則底下的筆記/ });
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await ask.locator("[data-action='keep-off-with-below']").click();
  await expect(ask).toHaveCount(0, { timeout: 15_000 });

  await expect.poll(async () => {
    await publishSite(page.request);
    const ids = await siteIds(page);
    return [parent, child, grandchild].some((n) => ids.has(n.id));
  }, { timeout: 20_000, intervals: [1_000] }).toBe(false);
  const after = await siteIds(page);
  expect(after.has(sibling.id)).toBe(true);
  expect(after.has(outsider.id)).toBe(false);
});

test("a note with nothing under it is kept off in one press, with no question", async ({ page }) => {
  const stamp = Date.now();
  const leaf = await mk(page, await createPublishingSpace(page.request), `Leaf ${stamp}`);
  await ready(page, `/?view=notes&node=${leaf.id}`);
  const { row, unpublish, putBack } = await openPublishRow(page);
  await unpublish.click();
  await expect(putBack).toBeVisible({ timeout: 15_000 });
  await expect(row.locator(".publish-left-out-confirm")).toHaveCount(0);
  await publishSite(page.request);
  expect((await siteIds(page)).has(leaf.id)).toBe(false);
});

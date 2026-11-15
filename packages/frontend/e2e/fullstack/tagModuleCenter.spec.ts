import { test, expect, type Page } from "@playwright/test";
import { ready, renderSettled, moduleTag, giveTagFunction, removeFunctionViaChip, openFunctionDetails, tagFunctionEntry, tagFunctionLine, BASE, H } from "./helpers";

import { makeReviewCard } from "./reviewFixtures";

const WRITE = H;

test.beforeEach(async ({ page }) => {
  const target = new URL(BASE);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
  expect(["5099", "5100"], "failure injection belongs to the isolated test stack").toContain(target.port);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tag-module-test-started")) return;
    sessionStorage.setItem("tag-module-test-started", "1");
    localStorage.setItem("onden.locale", "en");
    localStorage.setItem("theme", "dark");
  });
});

async function seed(page: Page, label: string) {
  const suffix = Date.now();
  const name = `${label} ${suffix}`;
  const resolved = await page.request.post("/api/tags/resolve-path", { ...WRITE, data: { path: name } });
  expect(resolved.ok()).toBe(true);
  const tagId = (await resolved.json()).leaf_id as string;
  const created = await page.request.post("/api/nodes", { ...WRITE, data: { title: `閱讀筆記 ${suffix}`, markdown: "Q: 筆記的功能從哪裡來？\nA: 它所套用的標籤。" } });
  expect(created.ok()).toBe(true);
  const note = await created.json() as { id: string; title: string };
  expect((await page.request.put(`/api/nodes/${note.id}/tags/${tagId}`, { ...WRITE, data: {} })).ok()).toBe(true);
  return { tagId, note, name };
}

async function cleanup(page: Page, ids: string[]) {
  for (const id of ids) expect((await page.request.delete(`/api/nodes/${id}`, WRITE)).ok()).toBe(true);
}

const toast = (page: Page, text: string) => page.locator(".toast-message").filter({ hasText: text });

/** A member's row on a tag page. A wide titles-only list adds when the note
 *  changed and how it begins under the title (MemberList's rich rows), so the
 *  button's name is more than the title: match the title line itself. The
 *  table layout (fields with values) names its row button by the title. */
const memberRow = (page: Page, title: string) => page.locator(".tag-member-list li button")
  .filter({ has: page.locator(".tag-member-title").getByText(title, { exact: true }) })
  .or(page.locator(".tag-member-table").getByRole("button", { name: title, exact: true }));

test("a function a tag holds survives reload and rename, the tag scopes review, and it fits desktop and phones", async ({ page }) => {
  const { tagId, note, name } = await seed(page, "課程閱讀");
  const skillsTag = await moduleTag(page, "skills");
  const parent = await seed(page, "上層課程");
  try {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    expect(boot.nodes.find((row: { id: string }) => row.id === note.id).label_tag_ids).toContain(tagId);
    await ready(page, `/?view=notes&node=${tagId}`);
    await expect(page.locator(".schema-lens-title")).toHaveText(`#${name}`);
    await expect(memberRow(page, note.title)).toBeVisible();
    // The notes come first; a tag with no function has no line of functions and no 「加功能」 (2026-11-12).
    await expect(tagFunctionLine(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add function" })).toHaveCount(0);
    // Review is no longer a function a tag gives (a card is the note's own reference): the tag only picks
    // which cards to study, so asking a tag for it is refused.
    expect((await page.request.put(`/api/tags/${tagId}/functions/review`, { ...WRITE, data: {} })).status()).toBe(400);
    await makeReviewCard(page.request, note.id);
    await giveTagFunction(page, tagId, "skills", "Skills");
    // A tag only gets a function by extending a module's tag. Inheritance from
    // an ordinary tag is refused for a NEW target (D105, services/tagModules.ts
    // setTagExtends: "a tag can only extend a module tag"), so no UI or API
    // creates one any more.
    await expect(page.getByRole("combobox", { name: /inherit/i })).toHaveCount(0);
    const current = await (await page.request.get(`/api/tags/${tagId}`)).json() as { extends: string[] };
    const refused = await page.request.put(`/api/tags/${tagId}/extends`, { ...WRITE, data: { extends: [...current.extends, parent.tagId] } });
    expect(refused.status()).toBe(400);

    const renamed = `學習資料 ${Date.now()}`;
    expect((await page.request.patch(`/api/nodes/${tagId}`, { ...WRITE, data: { title: renamed } })).ok()).toBe(true);
    await ready(page, `/?view=notes&node=${tagId}`);
    await expect(page.locator(".schema-lens-title")).toHaveText(`#${renamed}`);
    // Still the tag's own: its × is there.
    await expect(tagFunctionEntry(page, "Skills").getByRole("button", { name: `Remove “Skills” from #${renamed}`, exact: true })).toBeEnabled();
    const stored = await (await page.request.get(`/api/tags/${tagId}`)).json() as { extends: string[] };
    expect(stored.extends).toEqual([skillsTag.id]);
    // The tag picks which cards to study: its scope holds the note, whose card is the note's own.
    const queue = await (await page.request.get(`/api/review/queue?tag_id=${tagId}`)).json();
    expect(queue.cards.map((card: { node_id: string }) => card.node_id)).toContain(note.id);
    // The module tag's page lists the notes of tags that add its function (the tag is a member of Skills' scope).
    await ready(page, `/?view=notes&node=${skillsTag.id}`);
    await expect(page.locator(".schema-lens-title")).toBeVisible();

    // One functional journey, then resize the same state for visual evidence.
    await page.evaluate(() => localStorage.setItem("onden.locale", "zh-TW"));
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await ready(page, `/?view=notes&node=${tagId}`);
      await expect(tagFunctionLine(page).locator(".tag-fn-entry").first()).toBeVisible();
      await expect(memberRow(page, note.title)).toBeVisible();
      await renderSettled(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      // What shapes the tag is on the page itself: the field and function rows' controls.
      const actions = await page.locator(".tag-page-row button:visible, .tag-member-list button").all();
      for (const action of actions) {
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        if (width < 600) expect(box!.height, await action.innerText()).toBeGreaterThanOrEqual(43.5);
      }
      await page.screenshot({ path: `/tmp/pw-output/tag-module-center-${width}.png` });
      if (width === 1280) await page.locator(".schema-lens").screenshot({ path: "/tmp/pw-output/tag-module-center.png" });
    }

    // The × takes the function off this tag only.
    await page.evaluate(() => localStorage.setItem("onden.locale", "en"));
    await page.setViewportSize({ width: 1280, height: 900 });
    await ready(page, `/?view=notes&node=${tagId}`);
    await removeFunctionViaChip(page, "Skills");
    expect((await (await page.request.get(`/api/tags/${tagId}`)).json() as { extends: string[] }).extends).toEqual([]);
    // Taking the tag's function away does not touch the note's own card.
    expect((await (await page.request.get(`/api/review/cards/${note.id}`)).json() as { card: boolean }).card).toBe(true);
  } finally {
    // Leave the module tags in place: other specs use them.
    await cleanup(page, [note.id, tagId, parent.note.id, parent.tagId]);
  }
});

// A tag's functions are references (function-references proposal): the × sends
// DELETE /api/tags/:id/functions/:functionId. A refusal leaves the entry; a lost
// connection retries the same intent with the same idempotency key.
test("the × on a held function: a 403 leaves it, a 503 retries with the same key, then it goes once", async ({ page }) => {
  const { tagId, note } = await seed(page, "Rejected remove");
  const keys: string[] = [];
  const route = `**/api/tags/${tagId}/functions/skills`;
  try {
    await moduleTag(page, "skills");
    await ready(page, `/?view=notes&node=${tagId}`);
    await giveTagFunction(page, tagId, "skills", "Skills");
    await page.route(route, async (r) => {
      if (r.request().method() !== "DELETE") { await r.continue(); return; }
      keys.push(r.request().headers()["idempotency-key"] ?? "");
      if (keys.length === 1) await r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' });
      else if (keys.length === 2) await r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      else await r.continue();
    });
    const entry = tagFunctionEntry(page, "Skills");
    const cross = entry.getByRole("button", { name: /^(Remove “.*” from #|從 #.* 移除「.*」$)/ });
    await cross.click();
    await expect(toast(page, "You don't have permission to do that.")).toBeVisible();
    await expect(entry).toBeVisible();
    await cross.click();
    await expect(toast(page, "Could not reach the server. Try again when the connection is available.")).toBeVisible();
    await expect(entry).toBeVisible();
    await cross.click();
    await expect(entry).toHaveCount(0);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[1]);
  } finally { await page.unroute(route); await cleanup(page, [note.id, tagId]); }
});

test("an open review drawer clears its held card when the note stops being a review card", async ({ page }) => {
  const { tagId, note } = await seed(page, "Session card");
  // 「Review cards under this note」 is offered where cards sit UNDER the note: put the card in a deck.
  const deck = await (await page.request.post("/api/nodes", { ...WRITE, data: { title: `Deck ${Date.now()}`, markdown: "" } })).json() as { id: string };
  try {
    expect((await page.request.patch(`/api/nodes/${note.id}`, { ...WRITE, data: { parent_id: deck.id } })).ok()).toBe(true);
    await makeReviewCard(page.request, note.id);
    await ready(page, `/?view=notes&node=${deck.id}`);
    await page.locator(".palette-trigger").click();
    await page.locator(".palette-input-wrap input").fill(">Review cards under this note");
    await page.locator(".palette-item", { hasText: "Review cards under this note" }).click();
    const panel = page.locator(".review-panel");
    await expect(panel.locator(".review-card-title")).toHaveText(note.title);
    await panel.locator(".review-reveal").click();
    await expect(panel.locator(".review-card-body")).toContainText("它所套用的標籤");
    expect((await page.request.delete(`/api/review/cards/${note.id}`, WRITE)).ok()).toBe(true);
    await expect(panel.locator(".review-card-title")).toHaveCount(0);
    await expect(panel.locator(".review-card-body")).toHaveCount(0);
    expect((await (await page.request.get(`/api/review/cards/${note.id}`)).json() as { card: boolean }).card).toBe(false);
  } finally { await cleanup(page, [note.id, deck.id, tagId]); }
});

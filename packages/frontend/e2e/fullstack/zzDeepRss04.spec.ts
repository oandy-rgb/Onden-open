// Feature-audit deepening (2026-10-07): RSS-04 — skip / skip-all: failure must
// not look seen, counts agree across entry points, reopen keeps state, source
// scope for another human, and whether seen-state is shared.
// Seen is per person unless the space turns on shared_seen (modules/rss/items.ts: "Seen is per person (rss_seen)", sourceSpace.ts).
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { ready, defaultSpaceId, createSpace, addToDefaultSpace, BASE, H } from "./helpers";
import { publishFeedArticles, siteFeedUrl } from "./feedHelpers";

type Item = { id: string; title: string; seen: boolean };
// The feed's articles are published from a space that publishes (the default space does not). A subscription is a
// row in a space, not a note (2026-10-28, migration 145): it lives where the workspace setting 訂閱放在 says
// (`PUT /api/rss/source-space`), so the source is shared with the default space — the second human sees it —
// until a run puts it in a space nobody else is in.
const putSourceSpace = async (page: Page, spaceId: string) =>
  expect((await page.request.put("/api/rss/source-space", { ...H, data: { space_id: spaceId } })).ok(), `訂閱放在 ${spaceId || "(own space)"}`).toBe(true);

async function seed(page: Page, stamp: number, n = 3, sourceSpace?: string) {
  await publishFeedArticles(page.request, Array.from({ length: n }, (_, i) => `R04 art ${i} (${stamp})`), (i) => `Body ${i} of ${stamp}.`);
  await putSourceSpace(page, sourceSpace ?? await defaultSpaceId(page.request));
  const sub = await (await page.request.post("/api/rss/subscribe", { ...H, data: { url: siteFeedUrl(stamp) } })).json();
  await page.request.post(`/api/rss/sources/${sub.id}/refresh`, { ...H, data: {} });
  await expect.poll(async () => (await items(page.request, stamp)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
  return sub.id as string;
}
// 訂閱放在 is a workspace setting: put it back, so the specs after this one subscribe into each person's own space again.
test.afterEach(async ({ page }) => { await putSourceSpace(page, ""); });
const items = async (req: APIRequestContext, stamp: number): Promise<Item[]> =>
  (((await (await req.get("/api/rss/items?limit=200", H)).json()).items ?? []) as Item[]).filter((i) => i.title.includes(`(${stamp})`));
const unseenFor = async (req: APIRequestContext, sourceId: string) =>
  ((await (await req.get("/api/rss/sources", H)).json()).sources ?? (await (await req.get("/api/rss/sources", H)).json())).find?.((s: { id: string }) => s.id === sourceId)?.unseen;

test("RSS-04: next, counts, reopen, scope, per-person seen state", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const sourceId = await seed(page, stamp, 3);
  // Three new articles; the feed also carries the articles other specs published, so the source's count is compared by what changes.
  expect((await items(page.request, stamp)).filter((i) => !i.seen), "items").toHaveLength(3);
  const sourceUnseenBefore = (await unseenFor(page.request, sourceId)) as number;
  expect(sourceUnseenBefore, "the source counts at least the three").toBeGreaterThanOrEqual(3);

  // Open the reader (Reading › RSS: new articles left the inbox for it on 2026-10-18).
  await ready(page, "/?view=rss");
  const chips = page.locator(".rss-source-bar");
  await expect(chips).toContainText("Onden", { timeout: 20_000 }); // the feed's chip (the site's title); its count shows only when the reader is set to count
  await expect(chips).toContainText(/^All/); // pinned: today's behaviour, no written rule (an "All" chip stands first in the bar)
  await page.locator(".rss-item", { hasText: `(${stamp})` }).first().click();
  await expect(page.locator(".rss-article-body")).toBeVisible({ timeout: 15_000 });
  // The reader resumes where the person was (modules/rss/readingPosition.ts), so wait for the article that was clicked before reading its title.
  await expect(page.locator(".rss-article-title")).toContainText(`(${stamp})`);
  const leftTitle = ((await page.locator(".rss-article-title").textContent()) ?? "").trim();

  // Next (the card at the end): moving past an article marks it seen on the server (modules/rss/readingPosition.ts: "Articles you moved
  // past are seen through the existing seen mark, sent when an article is left").
  await page.locator(".rss-article-nav .rss-next-btn:not(.rss-prev-btn)").click();
  await expect(page.locator(".rss-article-title")).not.toHaveText(leftTitle);
  await expect.poll(async () => (await items(page.request, stamp)).find((i) => i.title === leftTitle)?.seen).toBe(true);
  // After a reload the state is the same, and the counts agree again: one fewer unread in the source and two of the three left (the reader's
  // chips show no count here, so the two APIs are compared).
  await page.reload({ waitUntil: "load" });
  await expect(page.locator(".rss-source-bar")).toContainText("Onden");
  const afterReload = await items(page.request, stamp);
  expect(afterReload.find((i) => i.title === leftTitle)?.seen).toBe(true);
  expect(afterReload.filter((i) => !i.seen)).toHaveLength(2);
  expect(await unseenFor(page.request, sourceId), "source count dropped by the one article that was left").toBe(sourceUnseenBefore - 1);

  // Another human (editor): seen is per person (items.ts), so the editor sees all three as new and marking them leaves the owner's count alone.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `R04 ${stamp}`, email: `r04-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `R04 ${stamp}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const edItems = await items(human.request, stamp);
  expect(edItems, "the editor sees the feed's articles").toHaveLength(3);
  expect(edItems.filter((i) => !i.seen), "and none is seen for them").toHaveLength(3);
  for (const it of edItems) await human.request.post(`/api/rss/items/${it.id}/seen`, { ...H, data: {} });
  await expect.poll(async () => (await items(human.request, stamp)).filter((i) => !i.seen).length).toBe(0);
  expect((await items(page.request, stamp)).filter((i) => !i.seen), "the owner's own seen marks are not touched").toHaveLength(2);
  // Restricted source: the owner moves the source to a space only they are in; the editor sees none of it and cannot mark it (404, no leak).
  const stamp2 = stamp + 1;
  await seed(page, stamp2, 1, await createSpace(page.request, `R04 hidden ${stamp}`));
  expect(await items(human.request, stamp2), "the editor sees nothing of the restricted source").toHaveLength(0);
  const ownerItems2 = await items(page.request, stamp2);
  expect((await human.request.post(`/api/rss/items/${ownerItems2[0].id}/seen`, { ...H, data: {} })).status(), "and cannot mark its article").toBe(404);
  expect((await items(page.request, stamp2)).filter((i) => !i.seen), "the owner's article stays unseen").toHaveLength(1);
  await human.close();
});

// FINDING: a failed "seen" mark must not look seen (this spec's header; docs/research/full-feature-audit.md GAP-137: "標記結果失敗時回復清單狀態並提示，
// 或排入既有寫入佇列"; docs/agents/errors-and-saves.md: only the server or the durable queue confirms). What the reader does instead: with POST /seen
// answering 503 it moves on, draws the left article as read in its list, shows no notice, queues nothing, and the server never records it.
test("FINDING: a failed seen mark is not drawn as read without being reported or queued", async ({ page }) => {
  test.fail();
  test.setTimeout(120_000);
  const stamp = Date.now();
  await seed(page, stamp, 3);
  await ready(page, "/?view=rss");
  await page.locator(".rss-item", { hasText: `(${stamp})` }).first().click();
  await expect(page.locator(".rss-article-body")).toBeVisible({ timeout: 15_000 });
  // The reader resumes where the person was (modules/rss/readingPosition.ts), so wait for the article that was clicked before reading its title.
  await expect(page.locator(".rss-article-title")).toContainText(`(${stamp})`);
  const leftTitle = ((await page.locator(".rss-article-title").textContent()) ?? "").trim();
  await page.route("**/api/rss/items/*/seen", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  const refusal = page.waitForResponse((r) => /\/api\/rss\/items\/[^/]+\/seen/.test(r.url()) && r.status() === 503);
  await page.locator(".rss-article-nav .rss-next-btn:not(.rss-prev-btn)").click();
  await expect(page.locator(".rss-article-title")).not.toHaveText(leftTitle);
  await refusal; // the seen mark was sent and refused
  // The reader has reacted to the refusal once React has drawn the frames after it.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.unroute("**/api/rss/items/*/seen");
  const row = page.locator(".rss-item", { hasText: leftTitle });
  // Either the list does not show it as read, or the mark reaches the server (queued retry).
  await expect.poll(async () => {
    const drawnRead = await row.first().evaluate((el) => el.classList.contains("read"));
    const seenOnServer = (await items(page.request, stamp)).find((i) => i.title === leftTitle)?.seen === true;
    return !drawnRead || seenOnServer;
  }, { timeout: 20_000 }).toBe(true);
});

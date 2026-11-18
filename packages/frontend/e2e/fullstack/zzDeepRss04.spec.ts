// Feature-audit deepening (2026-10-07): RSS-04 — skip / skip-all: failure must
// not look seen, counts agree across entry points, reopen keeps state, source
// scope for another human, and whether seen-state is shared.
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

test("RSS-04: skip failure, counts, reopen, scope, shared state", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now(); const out: Record<string, string> = {};
  const sourceId = await seed(page, stamp, 3);
  out.initial = `unseen=${await unseenFor(page.request, sourceId)} items=${(await items(page.request, stamp)).filter((i) => !i.seen).length}`;

  // Open the reader (Reading › RSS: new articles left the inbox for it on 2026-10-18).
  await ready(page, "/?view=rss");
  const chips = page.locator(".rss-source-bar");
  await expect(chips).toContainText("Onden", { timeout: 20_000 }); // the feed's chip (the site's title); its count shows only when the reader is set to count
  out.chipsText = JSON.stringify((await chips.innerText()).replace(/\s+/g, " ").slice(0, 80));
  await page.locator(".rss-item", { hasText: `(${stamp})` }).first().click();
  await expect(page.locator(".rss-article-body")).toBeVisible({ timeout: 15_000 });
  const firstTitle = (await page.locator(".rss-article-title").textContent()) ?? "";

  // Next (the card at the end; leaving marks seen) with /seen failing → must not be recorded as seen; does the UI advance?
  await page.route("**/api/rss/items/*/seen", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  await page.locator(".rss-article-nav .rss-next-btn:not(.rss-prev-btn)").click();
  await page.waitForTimeout(1500);
  const advanced = ((await page.locator(".rss-article-title").textContent()) ?? "") !== firstTitle;
  const notice = (await page.locator(".toast, [role='alert']").allInnerTexts()).slice(-1)[0] ?? "";
  await page.unroute("**/api/rss/items/*/seen");
  const afterFail = await items(page.request, stamp);
  out.skip503 = `uiAdvanced=${advanced} notice=${JSON.stringify(notice.replace(/\s+/g, " ").slice(0, 70))} serverSeen=${afterFail.find((i) => i.title === firstTitle.trim())?.seen}`;

  // Normal next, then reload: state persists.
  const cur = ((await page.locator(".rss-article-title").textContent()) ?? "").trim();
  await page.locator(".rss-article-nav .rss-next-btn:not(.rss-prev-btn)").click();
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2000);
  const afterReload = await items(page.request, stamp);
  out.skipReload = `skipped=${JSON.stringify(cur.slice(0, 30))} seen=${afterReload.find((i) => i.title === cur)?.seen} unseenNow=${afterReload.filter((i) => !i.seen).length} sourceUnseen=${await unseenFor(page.request, sourceId)}`;

  // Count agreement: the reader's feed chips / sources API / items API.
  await ready(page, "/?view=rss");
  await page.waitForTimeout(1500);
  const chipsNow = await page.locator(".rss-source-bar").innerText().catch(() => "(gone)");
  out.counts = `chips=${JSON.stringify(chipsNow.replace(/\s+/g, " ").slice(0, 80))} sources=${await unseenFor(page.request, sourceId)} items=${afterReload.filter((i) => !i.seen).length}`;

  // Another human (editor): shared seen-state and source scope.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `R04 ${stamp}`, email: `r04-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `R04 ${stamp}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const edItems = await items(human.request, stamp);
  out.editorSees = `${edItems.length} items, unseen=${edItems.filter((i) => !i.seen).length}`;
  for (const it of edItems) await human.request.post(`/api/rss/items/${it.id}/seen`, { ...H, data: {} });
  out.sharedState = `editorMarked=${edItems.length} ownerUnseenAfter=${(await items(page.request, stamp)).filter((i) => !i.seen).length}`;
  // Restricted source: owner moves the source to a space only they are in.
  const stamp2 = stamp + 1;
  await seed(page, stamp2, 1, await createSpace(page.request, `R04 hidden ${stamp}`));
  const hiddenItems = await items(human.request, stamp2);
  const ownerItems2 = await items(page.request, stamp2);
  const edSeen = ownerItems2[0] ? (await human.request.post(`/api/rss/items/${ownerItems2[0].id}/seen`, { ...H, data: {} })).status() : -1;
  out.scope = `editorSeesRestricted=${hiddenItems.length} editorSeenOne=${edSeen} ownerStillUnseen=${(await items(page.request, stamp2)).filter((i) => !i.seen).length}`;
  await human.close();
  console.log(`AUDIT RSS-04 ${JSON.stringify(out)}`);
});

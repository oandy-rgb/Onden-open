// Feature-audit deepening (2026-10-07): REV-05 — card content types (math,
// code, table, image, missing image, handwriting, empty), media permission
// for another human, and phone readability.
import { test, expect, type Page, type Browser } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const INK = JSON.stringify({ version: 1, page: { width: 800 }, erased: {}, strokes: [{ id: "s0", points: [[10, 10], [200, 120]], color: "#000", size: 3 }] });

async function deck(page: Page, s: number) {
  const media = await (await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `r${s}.png`, mimeType: "image/png", buffer: PNG } } })).json();
  // Default space: another human must be able to see the deck until it is locked.
  const d = await (await page.request.post("/api/nodes", { ...H, data: { title: `R05deck ${s}`, markdown: "d", space_id: await defaultSpaceId(page.request) } })).json();
  const bodies: Array<[string, string]> = [
    ["math", "Q: area?\nA: $$\\pi r^2$$"], ["code", "Q: loop?\nA:\n```js\nfor (let i=0;i<3;i++) console.log(i)\n```"],
    ["table", "| a | b |\n|---|---|\n| 1 | 2 |"], ["image", `Q: pic?\nA: ![p](${media.url})`],
    ["missing", "Q: gone?\nA: ![x](/api/media/does-not-exist.webp)"], ["ink", ""], ["empty", ""],
  ];
  const ids: Record<string, string> = {};
  for (const [i, [k, md]] of bodies.entries()) {
    const c = await (await page.request.post("/api/nodes", { ...H, data: { title: `R05 ${k} ${s}`, markdown: md, parent_id: d.id, sort_order: i } })).json();
    if (k === "ink") await page.request.put(`/api/nodes/${c.id}/attributes/ink_data`, { ...H, data: { value: INK, value_type: "text" } });
    await makeReviewCard(page.request, c.id);
    ids[k] = c.id;
  }
  return { deck: d.id as string, ids, mediaUrl: media.url as string };
}
async function walk(page: Page, deckId: string) {
  await ready(page, `/?view=notes&node=${deckId}`);
  // The phone's 更多 sheet no longer lists Search: the palette opens with the shortcut at any width.
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 15_000 });
  await page.locator(".palette-input-wrap input").fill(">Review cards");
  await page.locator(".palette-item", { hasText: "Review cards under this note" }).click();
  await expect(page.locator(".review-panel")).toBeVisible();
  const seen: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const title = (await page.locator(".review-card-title").innerText().catch(() => "")).trim();
    if (!title) break;
    const kind = title.split(" ")[1];
    await page.locator(".review-reveal").click();
    await page.waitForTimeout(700);
    const body = page.locator(".review-card-body");
    const box = await body.boundingBox();
    const img = await body.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth > 0));
    seen[kind] = JSON.stringify({ katex: await body.locator(".katex").count(), code: await body.locator("pre code").count(), table: await body.locator("table").count(), imgs: img, svg: await body.locator("svg").count(), text: (await body.innerText()).replace(/\s+/g, " ").slice(0, 40), w: box ? Math.round(box.width) : 0, overflowX: await body.evaluate((e) => e.scrollWidth > e.clientWidth + 1) });
    await page.locator(".review-grade--3").click();
    await page.waitForTimeout(600);
  }
  return seen;
}

async function phone(browser: Browser, base: Page) {
  const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  return { ctx, page: await ctx.newPage() };
}

test("REV-05: content types desktop and phone, media permission", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const s = Date.now();
  const d1 = await deck(page, s);
  console.log(`AUDIT REV-05 desktop ${JSON.stringify(await walk(page, d1.deck))}`);
  const d2 = await deck(page, s + 1);
  const { ctx, page: pp } = await phone(browser, page);
  const res = await walk(pp, d2.deck);
  const font = await pp.locator(".review-card-body").evaluate((e) => getComputedStyle(e).fontSize).catch(() => "?");
  console.log(`AUDIT REV-05 phone ${JSON.stringify(res)} font=${font} docWidth=${await pp.evaluate(() => document.documentElement.scrollWidth)}`);
  await pp.screenshot({ path: "/tmp/pw-output/rev05-phone.png" });
  await ctx.close();
  // Media permission: an image living only in a card the editor cannot read is
  // not served to them. A card shares its deck's space, so the whole deck d1
  // moves to an owner-only space.
  await hideFromOthers(page.request, d1.deck);
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `R05 ${s}`, email: `r05-${s}@example.com`, password: `pw-${s}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `R05 ${s}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const q = await (await human.request.get("/api/review/queue", H)).text();
  console.log(`AUDIT REV-05 perm ${JSON.stringify({ editorQueueHasLockedCard: q.includes(`R05 image ${s}`), editorMedia: (await human.request.get(d1.mediaUrl, H)).status(), otherImageStillUsedByD2: d2.mediaUrl !== d1.mediaUrl })}`);
  await human.close();
});

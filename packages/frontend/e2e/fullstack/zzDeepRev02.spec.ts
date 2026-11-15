// Feature-audit deepening (2026-10-07): REV-02 — four ratings each, fast
// double-click, phone failure path, and offline grade across a reload.
// Lost-response and pre-commit 503 on desktop: reviewGradeRecovery.spec.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";

async function deck(page: Page, label: string, n: number) {
  const d = await (await page.request.post("/api/nodes", { ...H, data: { title: `Deck ${label}`, markdown: "deck" } })).json();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await (await page.request.post("/api/nodes", { ...H, data: { title: `${label} card${i}`, markdown: `Q: ${label} ${i}\nA: a`, parent_id: d.id, sort_order: i } })).json();
    await makeReviewCard(page.request, c.id);
    ids.push(c.id);
  }
  return { deck: d.id as string, ids };
}
async function openDeck(page: Page, deckId: string) {
  await ready(page, `/?view=notes&node=${deckId}`);
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 15_000 });
  await page.locator(".palette-input-wrap input").fill(">Review cards");
  await page.locator(".palette-item", { hasText: "Review cards under this note" }).click();
  await expect(page.locator(".review-panel")).toBeVisible();
}
const state = async (page: Page, id: string) => {
  const a = await (await page.request.get(`/api/nodes/${id}/attributes`, H)).json() as Array<{ key: string; value: string }>;
  const s = a.find((x) => x.key === "_review_state"); return s ? JSON.parse(s.value) : null;
};

test("REV-02: each rating, double click, offline across reload", async ({ page }) => {
  test.setTimeout(180_000);
  const s = Date.now(); const out: Record<string, string> = {};
  const { deck: d, ids } = await deck(page, `R02-${s}`, 4);
  await openDeck(page, d);
  const gradeOrder: number[] = [];
  for (let i = 0; i < 4; i++) {
    const title = await page.locator(".review-card-title").innerText();
    const idx = Number(/card(\d)/.exec(title)?.[1]);
    gradeOrder.push(idx);
    await page.locator(".review-reveal").click();
    await page.locator(`.review-grade--${idx + 1}`).click();
    await page.waitForTimeout(500);
  }
  const states = await Promise.all(ids.map((id) => state(page, id)));
  out.ratings = JSON.stringify(states.map((st, i) => ({ rating: i + 1, reps: st?.reps, due: st?.due?.slice(0, 16), stability: st ? Number(st.stability).toFixed(2) : null })));
  out.doneText = JSON.stringify((await page.locator(".review-done").innerText().catch(() => "")).slice(0, 60));

  // Fast double click on the same grade button.
  const { deck: d2, ids: ids2 } = await deck(page, `R02dbl-${s}`, 2);
  let posts = 0;
  page.on("request", (r) => { if (/\/api\/review\/.+\/grade/.test(r.url())) posts++; });
  await openDeck(page, d2);
  await page.locator(".review-reveal").click();
  await page.locator(".review-grade--3").dblclick();
  await page.waitForTimeout(1500);
  const after = await Promise.all(ids2.map((id) => state(page, id)));
  out.doubleClick = `gradePosts=${posts} reps=${JSON.stringify(after.map((x) => x?.reps ?? 0))}`;

  // Offline grade then reload.
  const { deck: d3, ids: ids3 } = await deck(page, `R02off-${s}`, 1);
  await openDeck(page, d3);
  await page.context().setOffline(true);
  await page.locator(".review-reveal").click().catch(() => {});
  await page.waitForTimeout(800);
  out.offlineButtonsDisabled = String(await page.locator(".review-grade--3").isDisabled());
  const offlineUi = (await page.locator(".review-panel").innerText()).replace(/\s+/g, " ").slice(0, 120);
  await page.context().setOffline(false);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(6000);
  out.offline = `ui=${JSON.stringify(offlineUi)} serverReps=${(await state(page, ids3[0]))?.reps ?? 0}`;
  console.log(`AUDIT REV-02 ${JSON.stringify(out)}`);
});

test("REV-02: phone viewport grade failure keeps the card", async ({ browser, page: base }) => {
  const s = Date.now();
  const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const page = await ctx.newPage();
  const { deck: d, ids } = await deck(page, `R02ph-${s}`, 2);
  await openDeck(page, d);
  let first = true;
  await page.route("**/api/review/*/grade", (r) => { if (first) { first = false; return r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }); } return r.continue(); });
  const title = await page.locator(".review-card-title").innerText();
  await page.locator(".review-reveal").click();
  const btn = page.locator(".review-grade--3");
  const box = await btn.boundingBox();
  await btn.click();
  await page.waitForTimeout(800);
  const err = await page.locator(".review-error").innerText().catch(() => "");
  const sameCard = (await page.locator(".review-card-title").innerText()) === title;
  await btn.click();
  await page.waitForTimeout(1200);
  const reps = await Promise.all(ids.map(async (id) => (await state(page, id))?.reps ?? 0));
  console.log(`AUDIT REV-02 phone ${JSON.stringify({ btn: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "none", error: err.slice(0, 80), sameCard, repsAfterRetry: reps, docWidth: await page.evaluate(() => document.documentElement.scrollWidth) })}`);
  await page.screenshot({ path: "/tmp/pw-output/rev02-phone.png" });
  await ctx.close();
});

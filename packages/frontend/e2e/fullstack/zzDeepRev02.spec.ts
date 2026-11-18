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
// The caller's schedule of a card (GET /api/review/:id/state; the old `_review_state` attribute is not a place to read it any more): null until graded.
type Schedule = { reps: number; stability: number; difficulty: number; lapses: number; due: string; last_review: string };
const state = async (page: Page, id: string): Promise<Schedule | null> =>
  (await (await page.request.get(`/api/review/${id}/state`, H)).json()).state as Schedule | null;
// The first grade of a card sets its stability to the FSRS-4.5 default weight of that rating (modules/review/fsrs.ts: W[0..3] for Again, Hard, Good, Easy).
const FIRST_STABILITY = [0.4872, 1.4003, 3.7145, 13.8206];
const DAY_MS = 86_400_000;

test("REV-02: each rating, double click, offline across reload", async ({ page }) => {
  test.setTimeout(180_000);
  const s = Date.now();
  const { deck: d, ids } = await deck(page, `R02-${s}`, 4);
  await openDeck(page, d);
  for (let i = 0; i < 4; i++) {
    const title = await page.locator(".review-card-title").innerText();
    const idx = Number(/card(\d)/.exec(title)?.[1]);
    await page.locator(".review-reveal").click();
    await page.locator(`.review-grade--${idx + 1}`).click();
    // The next card (or the end of the deck) is on screen before the next grade is given.
    if (i < 3) await expect(page.locator(".review-card-title")).not.toHaveText(title);
  }
  // Each card was graded once with the rating of its button: reps 1, the FSRS-4.5 first stability of that rating, a lapse only for Again,
  // and a due date that many whole days after the review (modules/review/fsrs.ts: interval = stability, at least 1 day).
  for (const [i, id] of ids.entries()) {
    await expect.poll(async () => (await state(page, id))?.reps ?? 0, { message: `rating ${i + 1} was recorded` }).toBe(1);
    const st = (await state(page, id))!;
    expect(st.stability, `rating ${i + 1}: stability`).toBeCloseTo(FIRST_STABILITY[i], 4);
    expect(st.lapses, `rating ${i + 1}: lapses (only Again is a lapse)`).toBe(i === 0 ? 1 : 0);
    expect(Math.round((new Date(st.due).getTime() - new Date(st.last_review).getTime()) / DAY_MS), `rating ${i + 1}: days until due`).toBe(Math.max(1, Math.round(FIRST_STABILITY[i])));
  }
  await expect(page.locator(".review-done")).toHaveText("Done — 4 reviewed. See you next time.");

  // Fast double click on the same grade button: one grade, not two (the header; the second click may not grade a card that was never revealed).
  const { deck: d2, ids: ids2 } = await deck(page, `R02dbl-${s}`, 2);
  let posts = 0;
  page.on("request", (r) => { if (/\/api\/review\/.+\/grade/.test(r.url())) posts++; });
  await openDeck(page, d2);
  await page.locator(".review-reveal").click();
  await page.locator(".review-grade--3").dblclick();
  await expect.poll(async () => (await Promise.all(ids2.map((id) => state(page, id)))).filter(Boolean).length).toBe(1);
  expect(posts, "a double click sends one grade").toBe(1);
  const after = await Promise.all(ids2.map((id) => state(page, id)));
  expect(after.map((x) => x?.reps ?? 0).sort(), "one card graded once, the other untouched").toEqual([0, 1]);

  // Offline: grading is not offered (ReviewPanel.tsx: the grade buttons are disabled while offline), and nothing was graded after a reload.
  const { deck: d3, ids: ids3 } = await deck(page, `R02off-${s}`, 1);
  await openDeck(page, d3);
  await page.context().setOffline(true);
  await page.locator(".review-reveal").click();
  await expect(page.locator(".review-grade--3")).toBeDisabled();
  await page.context().setOffline(false);
  await page.reload({ waitUntil: "load" });
  await expect(page.locator(".obsidian-title-input, .app-topbar").first()).toBeVisible();
  expect(await state(page, ids3[0]), "nothing was graded offline").toBeNull();
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
  const box = (await btn.boundingBox())!;
  await btn.click();
  await expect(page.locator(".review-error")).toHaveText("Could not confirm this grade. Retry the same button to finish.");
  // The failed grade keeps the card on screen, so the same button can finish it.
  await expect(page.locator(".review-card-title")).toHaveText(title);
  // A phone tap target is at least 44 px and the page does not scroll sideways (frontend/e2e/layout-audit README: 手機點擊目標).
  expect(box!.width, "the grade button is a 44px tap target").toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll on the phone").toBeLessThanOrEqual(390);
  await btn.click();
  await expect.poll(async () => (await Promise.all(ids.map(async (id) => (await state(page, id))?.reps ?? 0))).reduce((a, b) => a + b, 0)).toBe(1);
  await ctx.close();
});

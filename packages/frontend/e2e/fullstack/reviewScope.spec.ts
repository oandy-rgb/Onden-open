// ⑥ composite learning flow — "Review cards under this note" scopes a study
// session to one lecture's subtree (its deck), so cards are reviewed where
// they live ("卡片長在空間結構上"), not from one global pile. The scoped queue
// is only a filter: the person's one daily cap still covers it.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";


const mk = (page: Page, title: string, parent_id?: string) =>
  page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, parent_id } }).then((r) => r.json());

test("'Review cards under this note' studies only the note's subtree", async ({ page }) => {
  const stamp = Date.now();

  // A lecture deck (L → a1 → a2) and an unrelated card in another deck.
  const lecture = await mk(page, `Lecture ${stamp}`);
  const a1 = await mk(page, `Card A1 ${stamp}`, lecture.id);
  const a2 = await mk(page, `Card A2 ${stamp}`, a1.id);
  const outsider = await mk(page, `Outsider ${stamp}`);
  for (const id of [a1.id, a2.id, outsider.id]) {
    await makeReviewCard(page.request, id);
  }

  await ready(page, `/?view=notes&node=${lecture.id}`);
  await page.waitForTimeout(1000);

  // Run the note-scoped palette action.
  await page.locator(".palette-trigger").click();
  await page.locator(".palette-input-wrap input").fill(">Review cards under this note");
  await page.locator(".palette-item", { hasText: "Review cards under this note" }).click();

  // The drawer shows the scope and exactly the subtree's two cards — the
  // outsider (a different deck) is excluded.
  await expect(page.locator(".review-scope-button")).toContainText(`Lecture ${stamp}`);
  await expect(page.locator(".review-count")).toHaveText("2 left");
  await expect(page.locator(".review-card-title")).toContainText(stamp.toString());

  // Grade both subtree cards; the "done" state confirms the session held
  // exactly those two — nothing from the global pile leaked into the scope.
  // Each card greets you front-side-up: reveal the answer before the grade
  // buttons render (the review module's recall-then-reveal UX) — the gate
  // resets per card, so reveal before EVERY grade.
  await page.locator(".review-reveal").click();
  await page.locator(".review-grade--3").click();
  await expect(page.locator(".review-count")).toHaveText("1 left");
  await page.locator(".review-reveal").click();
  await page.locator(".review-grade--3").click();
  await expect(page.locator(".review-done")).toContainText("2 reviewed");

  // The outsider was never touched — still a new card (no review state). Asked of the
  // card itself: the GLOBAL queue only lists as many cards as the person's daily cap allows,
  // which earlier specs of the day can use up.
  const outsiderState = await (await page.request.get(`/api/review/${outsider.id}/state`)).json();
  expect(outsiderState.state).toBeNull();
  // And it was never part of the lecture's scope.
  const scoped = await (await page.request.get(`/api/review/queue?root=${lecture.id}`)).json();
  expect(scoped.cards.some((c: { node_id: string }) => c.node_id === outsider.id)).toBe(false);
});

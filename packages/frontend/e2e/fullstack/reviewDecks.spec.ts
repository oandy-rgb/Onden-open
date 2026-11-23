// ⑥ deck discovery — the home strip surfaces the notes that host due cards
// ("decks"), each with its own "Study {title}" entry that opens a subtree-
// scoped session. Closes the loop: discover the deck → study it where it
// lives, instead of hunting for it then opening one global pile.
import { test, expect, type Page } from "@playwright/test";
import { makeReviewCard } from "./reviewFixtures";
import { H } from "./helpers";


const mk = (page: Page, title: string, parent_id?: string) =>
  page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, parent_id } }).then((r) => r.json());

test("the home strip lists a deck with due cards and 'Study' opens a scoped session", async ({ page }) => {
  const stamp = Date.now();

  // A home node so the HomeStart strip has a stage.
  const home = await mk(page, `Decks home ${stamp}`);
  expect((await page.request.patch("/api/workspace", { ...H, data: { home_node_id: home.id } })).ok()).toBeTruthy();

  // A deck (a plain note) hosting three due cards directly under it.
  const deck = await mk(page, `Geometry ${stamp}`);
  for (let i = 0; i < 3; i++) {
    const card = await mk(page, `G-card ${i} ${stamp}`, deck.id);
    await makeReviewCard(page.request, card.id);
  }

  await page.goto(`/?view=notes&node=${home.id}`, { waitUntil: "load" });
  const strip = page.locator(".home-start-review");
  await expect(strip).toBeVisible({ timeout: 15_000 });

  // The deck entry: "Study Geometry …" with a "3 due" hint.
  const deckBtn = strip.locator("button", { hasText: `Study Geometry ${stamp}` });
  await expect(deckBtn).toBeVisible();
  await expect(deckBtn).toContainText("3 due");

  // Studying it opens a subtree-scoped session over exactly that deck.
  await deckBtn.click();
  const panel = page.locator(".review-panel");
  await expect(panel.locator(".review-scope-button")).toContainText(`Geometry ${stamp}`);
  await expect(panel.locator(".review-count")).toHaveText("3 left");
  await expect(panel.locator(".review-card-title")).toContainText(stamp.toString());
});

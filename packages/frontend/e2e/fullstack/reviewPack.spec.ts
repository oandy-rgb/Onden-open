// Review's settings (docs/architecture/module-library.md): Review comes from the module library, not from a tag template. A card is a
// note or a paragraph with its own review reference (migration 195), no tag gives it, and how much a person reviews in a day is ONE
// number, their daily cap on the review status page; there is no separate new-card setting any more.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSettingsFromAvatar, openModuleCard, showAdvancedSettings, H } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";

const DAY_MS = 86_400_000;
const WRITE = H;

type ReviewState = { due: string; last_review: string; reps: number };

async function reviewState(page: Page, nodeId: string): Promise<ReviewState> {
  // Progress is per person (review_states): the caller's own schedule.
  const response = await page.request.get(`/api/review/${nodeId}/state`);
  expect(response.ok()).toBe(true);
  const { state } = await response.json() as { state: ReviewState | null };
  expect(state, "a grade persists for the grader").toBeTruthy();
  return state!;
}

async function setDailyCap(page: Page, value: number | null) {
  const response = await page.request.put("/api/me/prefs/reviewsPerDay", { ...WRITE, data: { value } });
  expect(response.ok(), `PUT reviewsPerDay → ${response.status()}`).toBe(true);
}

async function openTagPacks(page: Page) {
  await openSettingsFromAvatar(page, "Data and backup");
  await showAdvancedSettings(page);
  const widget = page.locator(".settings-tagpacks");
  await expect(widget).toBeVisible();
  return widget;
}

test("Review comes from the module library, not from the tag templates", async ({ page }) => {
  await ready(page, "/?view=notes");
  const widget = await openTagPacks(page);
  // Settings only imports a file; there is no template picker.
  await expect(widget.getByRole("button", { name: "Install" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await ready(page, "/?view=notes");
  // Creating a tag takes only a name now (no template picker), so Review can only come from the library.
  await openModuleCard(page, "review");
});

test("Review's settings page has no new-card setting; the one daily limit lives on the review status page", async ({ page }) => {
  await ready(page, "/?view=notes");
  const card = await openModuleCard(page, "review", { settings: true });
  await expect(card.getByRole("spinbutton", { name: /New cards per day/ })).toHaveCount(0);
  await expect(card.getByText(/new cards per day/i)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await setDailyCap(page, null);
  await ready(page, "/?view=notes");
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(">review");
  await page.locator(".palette-item", { hasText: "Go to Review" }).click();
  await page.getByRole("button", { name: "Review status" }).click();
  const limit = page.getByRole("region", { name: "Daily limit" });
  await expect(limit).toBeVisible();
  await expect(limit.getByText("No limit. Every card that is due is offered.")).toBeVisible();
  await limit.getByRole("spinbutton", { name: "Reviews per day" }).fill("7");
  await limit.getByRole("button", { name: "Save limit" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/me/prefs/reviewsPerDay")).json() as { value: number | null }).value).toBe(7);
  await setDailyCap(page, null);
});

test("the daily limit covers due and new cards together, and stats carry no separate new-card number", async ({ page }) => {
  const stamp = Date.now();
  const cards: string[] = [];
  for (let i = 0; i < 3; i++) {
    const response = await page.request.post("/api/nodes", { ...WRITE, data: { title: `Cap card ${i} ${stamp}`, markdown: "Q: Cap?\nA: Yes." } });
    expect(response.ok()).toBe(true);
    const id = (await response.json() as { id: string }).id;
    await makeReviewCard(page.request, id);
    cards.push(id);
  }
  try {
    await setDailyCap(page, 1);
    const queue = await (await page.request.get("/api/review/queue")).json() as { cards: Array<{ node_id: string }>; total: number };
    expect(queue.cards.length).toBeLessThanOrEqual(1);
    const stats = await (await page.request.get("/api/review/stats")).json() as Record<string, unknown>;
    expect(stats).not.toHaveProperty("new_per_day");
    expect(stats).not.toHaveProperty("budgets");
    expect(typeof stats.new_available).toBe("number");
    // Grading one uses the day's single place: nothing more is offered today.
    const first = queue.cards[0];
    if (first) {
      expect((await page.request.post(`/api/review/${first.node_id}/grade`, { ...WRITE, data: { rating: 3 } })).ok()).toBe(true);
      const after = await (await page.request.get("/api/review/queue")).json() as { cards: unknown[] };
      expect(after.cards).toHaveLength(0);
      const state = await reviewState(page, first.node_id);
      expect(state.reps).toBe(1);
      expect((Date.parse(state.due) - Date.parse(state.last_review)) / DAY_MS).toBeGreaterThanOrEqual(1);
    }
  } finally {
    await setDailyCap(page, null);
  }
});

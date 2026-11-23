import { test, expect, type Page } from "@playwright/test";
import { ready, openQuickCapture, pollBootstrap, H, saveQuickCapture } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";

// Review module (modules/review) — the human loop, driven like a user:
// capture a note through the UI, tag it #review, land on home, see the
// "ready to review" line, open the drawer, grade the card, watch the count
// drop. ([[verify-like-a-user]]: click the doors, don't just curl them.)
//
// Rerun-safe against the persistent e2e onden_test:
//   • the note title carries a per-run stamp;
//   • the shared #review tag is find-or-created;
//   • count assertions are DELTAS, never absolutes (prior runs leave graded
//     cards behind, and grading re-schedules them out of the due window).


async function bootstrap(page: Page) {
  return (await page.request.get("/api/bootstrap")).json();
}

test("review loop: capture → make it a review card → home shows due → grade → count drops", async ({ page }) => {
  const stamp = Date.now();
  const title = `Review probe ${stamp}`;

  // A home node so the HomeStart strip (and its review line) has a stage.
  const home = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Review home ${stamp}`, markdown: "## home" },
  })).json();
  const patched = await page.request.patch("/api/workspace", { ...H, data: { home_node_id: home.id } });
  expect(patched.ok(), `PATCH /api/workspace → ${patched.status()}`).toBeTruthy();

  await ready(page, "/?view=notes");

  // 1. Capture the note through the UI (quick capture — the daily driver).
  await openQuickCapture(page); // polls until the capture listener is attached
  await page.locator(".quick-capture-textarea").fill(title);
  await saveQuickCapture(page); // stays open for the next thought; closed after "Saved to …"

  // Poll the server until the capture lands (no fixed sleep on the round-trip).
  const note = await pollBootstrap(page, (b) => b.nodes.find((n: { title: string }) => n.title === title));
  expect(note, "the capture landed server-side").toBeTruthy();

  // 2. Enrol it: make the note a review card (its own reference; a tag makes none).
  await makeReviewCard(page.request, note.id);

  const statsBefore = await (await page.request.get("/api/review/stats")).json();
  expect(statsBefore.due, "the new card is due immediately").toBeGreaterThanOrEqual(1);

  // 3. Home shows the review line.
  await page.goto(`/?view=notes&node=${home.id}`, { waitUntil: "load" });
  const line = page.locator(".home-start-review");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line).toContainText(/ready to review/);

  // 4. The line opens the drawer; a due count and a card are showing.
  await line.locator("button").first().click();
  const panel = page.locator(".review-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".review-count")).toHaveText(/\d+ left/);
  let remaining = parseInt((await panel.locator(".review-count").textContent())!, 10);
  expect(remaining).toBeGreaterThanOrEqual(1);

  // 5. Grade until OUR card has been graded (prior runs' cards may queue
  //    ahead of it); the count must decrement on every grade. Each card
  //    greets you front-side-up: reveal the answer before the grade buttons
  //    render (the review module's recall-then-reveal UX) — the gate resets
  //    per card, so reveal inside the loop before every grade.
  let gradedOurs = false;
  while (remaining > 0 && !gradedOurs) {
    gradedOurs = (await panel.locator(".review-card-title").textContent()) === title;
    await panel.locator(".review-reveal").click();
    await panel.getByRole("button", { name: /Good/ }).click();
    remaining -= 1;
    if (remaining > 0) {
      await expect(panel.locator(".review-count")).toHaveText(`${remaining} left`);
    } else {
      await expect(panel.getByText(/Done — \d+ reviewed/)).toBeVisible();
    }
  }
  expect(gradedOurs, "our card came up and was graded").toBe(true);

  // 6. Server agrees: the graded cards left the due window.
  const statsAfter = await (await page.request.get("/api/review/stats")).json();
  expect(statsAfter.due).toBeLessThan(statsBefore.due);
  expect(statsAfter.learned).toBeGreaterThanOrEqual(statsBefore.learned + 1);

  // And we now hold FSRS state for the note (graded exactly once → reps 1).
  // Progress is per person (review_states), not an attribute on the note.
  const { state } = (await (await page.request.get(`/api/review/${note.id}/state`)).json()) as { state: { reps: number } | null };
  expect(state, "the grader's own card state").toBeTruthy();
  expect(state!.reps).toBe(1);
});

test("panel says how many new cards today's one daily cap still allows", async ({ page }) => {
  const stamp = Date.now();
  // Enrol a fresh, never-graded card so `new` > 0 and the budget line shows.
  const note = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Budget probe ${stamp}`, markdown: "front" },
  })).json();
  await makeReviewCard(page.request, note.id);

  // stats carries how many new cards the cap still allows; no other number limits new cards.
  const stats = await (await page.request.get("/api/review/stats")).json();
  expect(typeof stats.new_available).toBe("number");
  expect(stats.new_per_day).toBeUndefined();
  expect(stats.new).toBeGreaterThanOrEqual(1);

  // The palette opens the scope the person last chose; earlier specs of this user may have left a narrow one.
  await page.request.put("/api/me/prefs/reviewScope", { ...H, data: { value: "all" } });
  await ready(page, "/?view=notes");
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(">review");
  await page.locator(".palette-item", { hasText: "Go to Review" }).click(); // modules/review openCommand

  const budget = page.locator(".review-budget");
  await expect(budget).toBeVisible({ timeout: 10_000 });
  // "{n} new cards available today" — the one daily cap's remainder.
  await expect(budget).toContainText(/\d+ new cards available today/);
});

test("command palette: 'Go to Review' opens the review screen", async ({ page }) => {
  await ready(page, "/?view=notes");
  // The ⌘K listener attaches in a mount effect that can land after the shell
  // is visible — poll the keypress until the palette actually opens.
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator(".palette-input-wrap input")).toBeFocused();
  await page.locator(".palette-input-wrap input").fill(">review");
  const item = page.locator(".palette-item", { hasText: "Go to Review" }); // modules/review openCommand
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator(".review-panel")).toBeVisible();
});

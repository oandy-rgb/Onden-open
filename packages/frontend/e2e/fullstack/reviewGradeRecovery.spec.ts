import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";

const WRITE = H;

async function createNode(page: Page, title: string, parentId?: string): Promise<string> {
  const response = await page.request.post("/api/nodes", {
    ...WRITE, data: { title, markdown: `Q: ${title}\nA: Remember it.`, parent_id: parentId },
  });
  expect(response.ok(), `create ${title} → ${response.status()}`).toBe(true);
  return (await response.json() as { id: string }).id;
}

async function reps(page: Page, nodeId: string): Promise<number> {
  // Review progress is per person (review_states): read the caller's own.
  const response = await page.request.get(`/api/review/${nodeId}/state`);
  expect(response.ok()).toBe(true);
  const { state } = await response.json() as { state: { reps: number } | null };
  return state?.reps ?? 0;
}

test("review grade keeps its card and key after a lost response or pre-commit 503", async ({ page }) => {
  const stamp = Date.now();

  const deck = await createNode(page, `Recovery deck ${stamp}`);
  const committed = await createNode(page, `Committed grade ${stamp}`, deck);
  const refused = await createNode(page, `503 grade ${stamp}`, deck);
  for (const id of [committed, refused]) {
    await makeReviewCard(page.request, id);
  }

  const keys = new Map<string, string[]>();
  let committedResponseStatus: number | null = null;
  await page.route("**/api/review/*/grade", async (route) => {
    const id = route.request().url().split("/grade")[0]!.split("/").at(-1)!;
    const seen = keys.get(id) ?? [];
    seen.push(route.request().headers()["idempotency-key"] ?? "");
    keys.set(id, seen);
    if (id === committed && seen.length === 1) {
      // Let the real PostgreSQL transaction commit, then lose only the reply.
      const response = await route.fetch();
      committedResponseStatus = response.status();
      await route.abort("failed");
    } else if (id === refused && seen.length === 1) {
      // A 503 before reaching the server must not consume the durable key.
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
    } else {
      await route.continue();
    }
  });

  await ready(page, `/?view=notes&node=${deck}`);
  await page.locator(".palette-trigger").click();
  await page.locator(".palette-input-wrap input").fill(">Review cards under this note");
  await page.locator(".palette-item", { hasText: "Review cards under this note" }).click();
  await expect(page.locator(".review-card-title")).toHaveText(`Committed grade ${stamp}`);

  await page.locator(".review-reveal").click();
  await page.locator(".review-grade--3").click();
  await expect(page.locator(".review-error")).toContainText("Retry the same button");
  expect(committedResponseStatus).toBe(200);
  expect(await reps(page, committed)).toBe(1);
  // The event-triggered queue check retires the now-scheduled card's content,
  // while its unconfirmed grading intent remains available with the same key.
  await expect(page.locator(".review-card-title").filter({ hasText: `Committed grade ${stamp}` })).toHaveCount(0);
  await expect(page.locator(".review-card-body")).toHaveCount(0);
  await expect(page.locator(".review-grade--2")).toHaveCount(0);
  await page.locator(".review-grade--3").click();
  await expect(page.locator(".review-card-title")).toHaveText(`503 grade ${stamp}`);
  expect(await reps(page, committed)).toBe(1);
  expect(keys.get(committed)).toHaveLength(2);
  expect(keys.get(committed)?.[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(keys.get(committed)?.[1]).toBe(keys.get(committed)?.[0]);

  await page.locator(".review-reveal").click();
  await page.locator(".review-grade--3").click();
  await expect(page.locator(".review-error")).toContainText("Retry the same button");
  expect(await reps(page, refused)).toBe(0);
  await page.locator(".review-grade--3").click();
  await expect(page.locator(".review-done")).toContainText("2 reviewed");
  expect(await reps(page, refused)).toBe(1);
  expect(keys.get(refused)).toHaveLength(2);
  expect(keys.get(refused)?.[1]).toBe(keys.get(refused)?.[0]);
});

import { test, expect, type Page } from "@playwright/test";
import { ready, seedNodes } from "./helpers";

async function cachedNote(page: Page) {
  const title = `workspace-check-${Date.now()}`;
  const [id] = await seedNodes(page, 1, { title: () => title });
  const url = `/?view=notes&node=${id}`;
  await ready(page, url);
  await expect(page.locator(".membership-gate")).toHaveCount(0);
  await expect(page.locator(".obsidian-title-input")).toHaveValue(title);
  // The worker's cache export is debounced by 2 s. Keep the same browser
  // context, then close the old page's requests before injecting a boot failure.
  await page.waitForTimeout(2500);
  await page.goto("about:blank");
  return { url, title };
}

test("cached workspace recovers from temporary membership failure without a manual click", async ({ page }) => {
  const { url, title } = await cachedNote(page);
  let failing = true;
  let refused = 0;
  // The membership check asks for the digest first (GET /api/sync/membership/digest, also
  // prefetched at boot) and pages (GET /api/sync/membership?cursor=…) only for a set that
  // differs; a cached copy that matches never pages. Fail both, so the check itself fails.
  await page.route(url => /^\/api\/sync\/membership(\/digest)?$/.test(url.pathname), async route => {
    if (failing) {
      refused++;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary test failure"}' });
    } else await route.continue();
  });
  await page.goto(url, { waitUntil: "load" });
  await expect.poll(() => refused).toBeGreaterThan(0);
  await expect(page.locator(".membership-gate")).toBeVisible();
  failing = false;
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".obsidian-title-input")).toHaveValue(title);
});

test("stalled sync read expires and a fresh check restores the cached workspace", async ({ page }) => {
  const { url, title } = await cachedNote(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  let started = 0;
  let abortedAfter = 0;
  page.on("requestfailed", request => {
    if (new URL(request.url()).pathname === "/api/sync" && started) abortedAfter = Date.now() - started;
  });
  await page.route("**/api/sync", async route => {
    if (first) {
      first = false;
      started = Date.now();
      await held;
      await route.abort().catch(() => {});
    } else await route.continue();
  });
  try {
    await page.goto(url, { waitUntil: "load" });
    await expect.poll(() => started).toBeGreaterThan(0);
    await expect(page.locator(".membership-gate")).toBeVisible();
    await expect.poll(() => abortedAfter, { timeout: 20_000 }).toBeGreaterThanOrEqual(14_000);
    await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".obsidian-title-input")).toHaveValue(title);
  } finally { release(); }
});

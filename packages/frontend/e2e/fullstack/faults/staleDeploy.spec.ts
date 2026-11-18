// Scenario 8 — a deploy happens while the app is open. The old tab still holds
// the old index; the new frontend no longer serves the old hashed chunks, which
// is simulated by answering every not-yet-loaded `/_astro/*.js` with a 404 HTML
// page after load (what the server returns for a missing file). Opening a lazy
// feature then fails to import its chunk. A different BUILD_ID alone cannot be
// served without a second build, so the chunk 404 is the whole simulation.
//
// 8a: the first stale chunk reloads once, after the unsaved draft was flushed;
//     the 404s stop at the navigation (the "new deploy" is now being served).
// 8b: the reload guard already spent (as after a recent reload) so the error
//     screen with its Reload button shows; the draft is kept and Reload works.
import { test, expect } from "@playwright/test";
import {
  FAULTS_TAG, editor, expectColdConvergence, expectServerHas, openNote, seedNote, skipUnlessRequested, typeInNote, uniqueToken,
} from "./faultKit";
import type { Page } from "@playwright/test";

test.beforeEach(skipUnlessRequested);

// With a service worker controlling the page, the app fetches the code of every screen that loads on use, once idle
// (lib/offlineWarmup.ts, 033259067, 2026-11-12), so by the time a chunk could be refused the lazy feature is already in
// memory and nothing fails. A stale tab hits this only for a screen it has not loaded; without a worker nothing is warmed.
test.use({ serviceWorkers: "block" });

/** 404 every script request until the next document navigation. */
async function breakChunks(page: Page): Promise<() => number> {
  let broken = true;
  let served404 = 0;
  page.on("request", (req) => { if (req.isNavigationRequest()) broken = false; });
  await page.route("**/_astro/**/*.js", (route) => {
    if (!broken) return route.continue();
    served404++;
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title>" });
  });
  return () => served404;
}

/** Type an unsaved draft, then open the lazily loaded version history. */
async function typeAndOpenLazyFeature(page: Page, text: string): Promise<void> {
  await typeInNote(page, "end", ` ${text}`);
  await page.locator(".note-history-link").click();
}

test("8a: a stale chunk reloads once and the draft survives", { tag: FAULTS_TAG }, async ({ page }) => {
  test.setTimeout(90_000);
  const text = uniqueToken("deploy");
  const id = await seedNote(page);
  await openNote(page, id);
  const stale = await breakChunks(page);
  const reloaded = page.waitForEvent("load", { timeout: 30_000 });
  await typeAndOpenLazyFeature(page, text);
  await reloaded;
  expect(stale(), "a lazy chunk must have been requested and refused (pick another lazy feature if the chunk was preloaded)").toBeGreaterThan(0);
  await expectServerHas(page, id, [text]);
  await openNote(page, id);
  await expect.poll(() => editor(page).innerText()).toContain(text);
  await expectColdConvergence(page.context(), id, [text]);
});

test("8b: with the reload guard spent, the error screen offers Reload and keeps the draft", { tag: FAULTS_TAG }, async ({ page }) => {
  test.setTimeout(90_000);
  const text = uniqueToken("deploy");
  const id = await seedNote(page);
  await openNote(page, id);
  // lib/lazyWithReload: a reload for another build within 30 s blocks the next one.
  await page.evaluate(() => sessionStorage.setItem("onden.chunkReload", JSON.stringify({ build: "previous-build", at: Date.now() })));
  const stale = await breakChunks(page);
  await typeAndOpenLazyFeature(page, text);

  const errorScreen = page.locator(".app-error-boundary");
  await expect(errorScreen).toBeVisible();
  await expect(errorScreen.getByRole("button", { name: /reload|重新載入/i })).toBeVisible();
  expect(stale()).toBeGreaterThan(0);
  // The draft was flushed before the error screen, not left in the dead page.
  await expectServerHas(page, id, [text]);

  await errorScreen.getByRole("button", { name: /reload|重新載入/i }).click(); // navigation ends the 404s
  await openNote(page, id);
  await expect.poll(() => editor(page).innerText()).toContain(text);
  await expectColdConvergence(page.context(), id, [text]);
});

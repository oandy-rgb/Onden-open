// Scenario 3 — a request that never answers. The first save is held by a route
// that never fulfils it (a dead connection that neither fails nor completes);
// every later request goes through. Later saves must still reach the server and
// nothing may wait on the stalled request forever: since #616 each write attempt
// has a deadline (WRITE_ATTEMPT_DEADLINE_MS, 25 s), after which it is queued
// under the same idempotency key and retried (lib/data/writeQueue.ts).
//
// The route stays installed for the whole test. Removing it (`page.unroute`)
// releases the held request, so the save it held was answered at once and the
// test passed without any stall (that is why it was "expected to fail, but
// passed": run 44074610697 and the 2026-11-18 audit).
import { test, expect, type Route } from "@playwright/test";
import {
  FAULTS_TAG, PHONE, expectColdConvergence, expectServerHas, openNote, seedNote, skipUnlessRequested,
  typeInNote, uniqueToken,
} from "./faultKit";
import type { Page } from "@playwright/test";

test.beforeEach(skipUnlessRequested);

async function stalledThenRecovered(page: Page): Promise<void> {
  const first = uniqueToken("stalled");
  const later = uniqueToken("later");
  const id = await seedNote(page);
  await openNote(page, id);

  const held: Route[] = [];
  const noteWrite = `**/api/nodes/${id}`;
  await page.route(noteWrite, (route) => {
    // Only the first save is held, never fulfilled; its retry and later saves go through.
    if (route.request().method() === "PATCH" && held.length === 0) held.push(route);
    else void route.continue();
  });
  try {
    const stalled = page.waitForRequest((req) => req.method() === "PATCH" && req.url().includes(id));
    await typeInNote(page, "end", ` ${first}`);
    await stalled;

    // The connection is back for new requests; the held one stays dead.
    await typeInNote(page, "end", ` ${later}`);

    // Nothing waits forever: the stalled text is retried and the later text lands.
    await expectServerHas(page, id, [first, later], 60_000);
  } finally {
    await page.unroute(noteWrite);
    for (const route of held) await route.abort("failed").catch(() => {});
  }
  await expectColdConvergence(page.context(), id, [first, later]);
}

test("3: a never-answered save must not block later saves", { tag: FAULTS_TAG }, async ({ page }) => {
  test.setTimeout(150_000);
  await stalledThenRecovered(page);
});

test.describe("phone viewport", () => {
  test.use({ ...PHONE });
  test("9b (scenario 3 on a Pixel-like phone)", { tag: FAULTS_TAG }, async ({ page }) => {
    test.setTimeout(150_000);
    await stalledThenRecovered(page);
  });
});

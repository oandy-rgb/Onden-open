// Scenario 3 — a request that never answers. The first save is held by a route
// that never fulfils it (a dead connection that neither fails nor completes).
// Once the "network" is back, later saves must still go through and nothing may
// wait on the stalled request forever. Today every write shares one lane, so a
// stalled request blocks all later saves: fix/a1-save-path.
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
    if (route.request().method() === "PATCH") held.push(route); // never fulfilled
    else void route.continue();
  });
  try {
    const stalled = page.waitForRequest((req) => req.method() === "PATCH" && req.url().includes(id));
    await typeInNote(page, "end", ` ${first}`);
    await stalled;

    // The network comes back: new requests flow, the held one stays dead.
    await page.unroute(noteWrite);
    await typeInNote(page, "end", ` ${later}`);

    // Nothing waits forever: the stalled text is retried and the later text lands.
    await expectServerHas(page, id, [first, later], 60_000);
  } finally {
    for (const route of held) await route.abort("failed").catch(() => {});
  }
  await expectColdConvergence(page.context(), id, [first, later]);
}

test("3: a never-answered save must not block later saves", { tag: FAULTS_TAG }, async ({ page }) => {
  test.fail(true, "fix/a1-save-path: one stalled request blocks the shared write lane");
  test.setTimeout(150_000);
  await stalledThenRecovered(page);
});

test.describe("phone viewport", () => {
  test.use({ ...PHONE });
  test("9b (scenario 3 on a Pixel-like phone)", { tag: FAULTS_TAG }, async ({ page }) => {
    test.fail(true, "fix/a1-save-path: one stalled request blocks the shared write lane");
    test.setTimeout(150_000);
    await stalledThenRecovered(page);
  });
});

// Scenario 6 — storage quota pressure. `Storage.overrideQuotaForOrigin` shrinks
// the origin's quota to almost nothing after the app loaded, so the next local
// snapshot / journal write fails with QuotaExceededError. Required: the app
// tells the person that the local copy could not be saved, and the edit is not
// lost (the server has it, and a cold reload shows it).
//
// The worker reports the failed snapshot write once; components/DeviceNotices
// shows the "storage is full" notice with a Retry button until a save works.
import { test, expect } from "@playwright/test";
import {
  FAULTS_TAG, expectColdConvergence, expectServerHas, openNote, seedNote, skipUnlessRequested, snapshotFingerprint,
  typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

test("6: snapshot saves failing on quota are reported and edits survive", { tag: FAULTS_TAG }, async ({ page, context }) => {
  test.setTimeout(120_000);
  const text = uniqueToken("quota");
  const id = await seedNote(page);
  await openNote(page, id);
  await expect.poll(() => snapshotFingerprint(page), { timeout: 30_000 }).not.toBe("none");

  const origin = new URL(page.url()).origin;
  // The page's own session: on Chromium 153 the browser-level one answers "Internal error" to this call,
  // the page-level one applies it (a 5 MB IndexedDB write then fails with QuotaExceededError; checked 2026-11-17).
  const pageCdp = await context.newCDPSession(page);
  await pageCdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1024 });
  try {
    // The edit reaches the server even though nothing can be written locally.
    await typeInNote(page, "end", ` ${text}`);
    await expectServerHas(page, id, [text]);

    // The app must say the local copy is not being saved. Any visible notice
    // (toast, banner, recovery panel) that names local storage / the device counts.
    const notice = page
      .locator(".toast, [role='alert'], [role='status'], .failed-write-recovery")
      .filter({ hasText: /storage|local|device|offline copy|space|quota|本機|儲存空間/i })
      .filter({ visible: true });
    await expect(notice.first(), "the app must report that the local copy could not be saved").toBeVisible({ timeout: 30_000 });
  } finally {
    await pageCdp.send("Storage.overrideQuotaForOrigin", { origin }); // no quotaSize: back to default
  }
  await expectColdConvergence(context, id, [text]);
});

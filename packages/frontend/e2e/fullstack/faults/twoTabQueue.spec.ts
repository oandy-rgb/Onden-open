// Scenarios 1 and 2 — two tabs of ONE browser context share one IndexedDB (as
// the installed PWA plus a browser tab do). Tab A goes offline and queues an
// edit; tab B stays online and saves its own snapshot of the local database;
// A's tab is closed before it reconnects. The queued edit must still be there
// when the app is opened again, and it must reach the server.
//
// Scenario 2 first lets A compact (its snapshot save lands and its journal
// records are dropped) so B's snapshot can only be wrong about A, not repaired
// by a journal replay. Both are the "stale tab's snapshot wipes the other
// tab's queue" bug, fixed by fix/b1-offline-queue.
import { test, expect, type BrowserContext } from "@playwright/test";
import {
  FAULTS_TAG, PHONE, expectColdConvergence, expectServerHas, journalEntryCount, offlineIndicator,
  openNote, seedNote, setPageOffline, skipUnlessRequested, snapshotFingerprint, typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

async function twoTabs(context: BrowserContext, compactBeforeB: boolean): Promise<void> {
  const tokenA = uniqueToken("offlineA");
  const tokenB = uniqueToken("onlineB");
  const pageA = await context.newPage();
  const id = await seedNote(pageA);
  await openNote(pageA, id);
  const pageB = await context.newPage();
  await openNote(pageB, id);

  // A: offline edit, durably queued (a journal record exists).
  await setPageOffline(pageA, true);
  await expect(offlineIndicator(pageA)).toBeVisible();
  const journalBefore = await journalEntryCount(pageA);
  await typeInNote(pageA, "end", ` ${tokenA}`);
  await expect.poll(() => journalEntryCount(pageA), { timeout: 20_000, message: "A's edit must reach the local journal" })
    .toBeGreaterThan(journalBefore);

  if (compactBeforeB) {
    // Compaction: A's snapshot (which contains its queue) lands and the journal
    // records it covers are deleted. Idle compaction is 15 s, hence the timeout.
    await expect.poll(() => journalEntryCount(pageA), { timeout: 60_000, message: "A must compact its journal" })
      .toBe(0);
  }

  // B: online edit; the live update refreshes B's mirror and B saves ITS
  // snapshot, built from a database that never saw A's queued write.
  const snapshotBefore = await snapshotFingerprint(pageB);
  await typeInNote(pageB, "start", `${tokenB} `);
  await expectServerHas(pageB, id, [tokenB]);
  await expect.poll(() => snapshotFingerprint(pageB), { timeout: 30_000, message: "B must save a local snapshot" })
    .not.toBe(snapshotBefore);

  // A's tab goes away while still offline; reopening must find the queue.
  await pageA.close();
  const reopened = await context.newPage();
  await openNote(reopened, id);
  await expectServerHas(reopened, id, [tokenA, tokenB]);
  await expectColdConvergence(context, id, [tokenA, tokenB]);
}

// Expected to fail on main until fix/b1-offline-queue lands.
test.describe("two tabs, shared IndexedDB", () => {
  test("1: stale tab's snapshot must not wipe the other tab's queued edit", { tag: FAULTS_TAG }, async ({ context }) => {
    test.fail(true, "fix/b1-offline-queue: a stale tab's snapshot overwrites the queued write");
    test.setTimeout(120_000);
    await twoTabs(context, false);
  });

  test("2: same, after A compacted before B saved its snapshot", { tag: FAULTS_TAG }, async ({ context }) => {
    test.fail(true, "fix/b1-offline-queue: a stale tab's snapshot overwrites the compacted queue");
    test.setTimeout(180_000);
    await twoTabs(context, true);
  });
});

test.describe("phone viewport", () => {
  test.use({ ...PHONE });
  test("9a (scenario 1 on a Pixel-like phone)", { tag: FAULTS_TAG }, async ({ context }) => {
    test.fail(true, "fix/b1-offline-queue: a stale tab's snapshot overwrites the queued write");
    test.setTimeout(120_000);
    await twoTabs(context, false);
  });
});

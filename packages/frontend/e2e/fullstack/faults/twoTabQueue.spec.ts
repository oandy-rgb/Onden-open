// Two tabs of ONE browser context share one IndexedDB (as the installed PWA plus a browser tab do). Tab A goes
// offline and queues an edit; tab B stays online and stores its own snapshot of the local database; both tabs are
// closed. The queued edit must still be on disk when the app is opened again, and that page must send it.
//
// What protects A's edit (#616): a snapshot is stored only over the generation its tab last loaded or saved
// (indexedDbStorage.ts, SnapshotStaleError); a stale tab first takes in the stored snapshot (localDbWorker.ts
// adoptStoredSnapshot). B also takes in the other tabs' queue before each send and at the start of each sync
// (writeQueue.ts absorbOtherTabs -> catchUpWithOtherTabs, which adopts a newer stored snapshot). So:
//  - 1 / 9a: B's sync request is held until A has queued and compacted, so B took in the other tabs BEFORE A's
//    edit existed; its snapshot save afterwards is stale and only the compare-and-swap keeps A's edit;
//  - 2: B's sync starts after A compacted, so B's catch-up adopts A's snapshot first.
// B's snapshot is caused by a server change arriving through live sync (a note created over the API), never by an
// edit in B (submitWrite would take in A's queue first). B is not allowed to send writes to the note, so A's text
// can only reach the server from the queue on disk, through the page opened at the end.
//
// The precondition for "A's edit is on disk" is A's editor saying "Waiting to sync" (draftActions.ts sets that only
// after submitWrite answered "queued", i.e. after the queue committed it) and then the journal back at 0 after a
// snapshot change (records are dropped only after a snapshot that contains them is stored). The journal record
// itself is short-lived (the 2026-11-18 audit), so it is not waited for.
import { test, expect, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import {
  FAULTS_TAG, PHONE, expectColdConvergence, expectServerHas, journalEntryCount, offlineIndicator,
  openNote, seedNote, setPageOffline, skipUnlessRequested, snapshotFingerprint, typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

/** B's delta request (POST /api/sync; not /api/sync/nodes and the other sync reads). */
const isSync = (request: Request): boolean => request.method() === "POST" && new URL(request.url()).pathname === "/api/sync";

/** A goes offline, types, and waits until the edit is queued and compacted into the stored snapshot. */
async function queueAndCompactOffline(pageA: Page, token: string): Promise<void> {
  await setPageOffline(pageA, true);
  await expect(offlineIndicator(pageA)).toBeVisible();
  const before = await snapshotFingerprint(pageA);
  await typeInNote(pageA, "end", ` ${token}`);
  await expect(pageA.locator(".obsidian-save-state").filter({ hasText: /^(Waiting to sync|等待同步)$/ }).first(),
    "A's save must be answered queued (committed to the local queue)").toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await journalEntryCount(pageA)) === 0 && (await snapshotFingerprint(pageA)) !== before,
    { timeout: 60_000, message: "A's queued edit must be compacted into the stored snapshot" }).toBe(true);
}

async function twoTabs(context: BrowserContext, holdBSync: boolean): Promise<void> {
  const tokenA = uniqueToken("offlineA");
  const pageA = await context.newPage();
  const id = await seedNote(pageA);
  await openNote(pageA, id);
  const pageB = await context.newPage();
  let bSynced = false;
  pageB.on("response", (response) => { if (isSync(response.request())) bSynced = true; });
  await openNote(pageB, id);
  await expect.poll(() => bSynced, { message: "B must finish its first sync" }).toBe(true);
  // B never sends a write to the note: only the page opened at the end may deliver A's queued edit.
  await pageB.route(`**/api/nodes/${id}`, (route) => (route.request().method() === "GET" ? route.continue() : route.abort("failed")));

  let held: Route | null = null;
  if (holdBSync) {
    // B's next sync takes in the other tabs (nothing queued yet), then its request waits here.
    const heldSync = new Promise<void>((resolve) => {
      void pageB.route("**/api/sync", (route) => {
        if (held || !isSync(route.request())) return route.continue();
        held = route; resolve();
      });
    });
    await seedNote(pageA); // a server change: the live update makes B sync
    await heldSync;
  }

  await queueAndCompactOffline(pageA, tokenA);
  const stored = await snapshotFingerprint(pageB);
  if (holdBSync) await (held as Route | null)!.continue(); // B applies the change and stores a snapshot built before A's edit
  else await seedNote(pageB); // B syncs now, after A compacted
  await expect.poll(() => snapshotFingerprint(pageB), { timeout: 30_000, message: "B must store a snapshot" }).not.toBe(stored);

  // Both tabs go away; the next page load must find A's edit on disk and send it.
  await pageB.unroute("**/api/sync");
  await pageA.close();
  await pageB.close();
  const reopened = await context.newPage();
  await openNote(reopened, id);
  await expectServerHas(reopened, id, [tokenA]);
  await expectColdConvergence(context, id, [tokenA]);
}

test.describe("two tabs, shared IndexedDB", () => {
  test("1: a stale tab's snapshot save keeps the other tab's compacted queue", { tag: FAULTS_TAG }, async ({ context }) => {
    test.setTimeout(150_000);
    await twoTabs(context, true);
  });

  test("2: a tab syncing after the other compacted takes its queue in first", { tag: FAULTS_TAG }, async ({ context }) => {
    test.setTimeout(150_000);
    await twoTabs(context, false);
  });
});

test.describe("phone viewport", () => {
  test.use({ ...PHONE });
  test("9a (scenario 1 on a Pixel-like phone)", { tag: FAULTS_TAG }, async ({ context }) => {
    test.setTimeout(150_000);
    await twoTabs(context, true);
  });
});

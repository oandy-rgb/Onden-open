// Journey [offline-capture-sync]: quick-capture WHILE OFFLINE persists locally
// (the write is queued, never dropped), then on reconnect the captured note
// drains to the backend — proven by reading it back through the server's own
// /api/bootstrap, not just the UI.
//
// This is the offline write-through contract end-to-end through the REAL UI:
//   QuickCapture.save() → sendOrQueue() → (transport fails offline) → queueWrite
//   → window "online" → useAppData.handleOnline → sync() → flushPendingWrites().
//
// Offline is simulated exactly like syncStatus.spec.ts: context.setOffline()
// cuts the transport, and we manually dispatch the window "offline"/"online"
// events because the app's own connection state flips on those events (Playwright
// toggling the network does not synthesise them). Asserting server truth uses
// page.request, which honours setOffline — so every server read happens AFTER we
// go back online, never against a severed transport.
//
// Idempotent against the shared onden_test DB: the capture text carries a
// per-run stamp so exactly one node ever matches (strict locators + "count 0"
// stay honest under parallel workers).
import { test, expect } from "@playwright/test";
import { ready, openQuickCapture, saveQuickCapture, ensureInbox, pollBootstrap, expectNoPending, expectOffline, expectOfflineReady, expectOnline, expectPending } from "./helpers";

test("offline quick-capture saves locally then syncs to the backend on reconnect", { tag: "@critical" }, async ({ page, context }) => {
  const stamp = Date.now();
  const text = `Offline thought ${stamp}`;

  // The capture goes to the inbox, whose tag exists before we go offline — the
  // only write the offline capture has to queue is the note itself.
  const inboxTag = await ensureInbox(page);
  await ready(page, "/?view=notes");
  await expectOnline(page);
  await expectNoPending(page); // clean queue

  await expectOfflineReady(page); // the capture box's code is on the device

  // ── Go offline ────────────────────────────────────────────────────────────
  await context.setOffline(true);
  // The app flips its own `online` state on the browser event (Playwright's
  // setOffline doesn't synthesise it); QuickCapture then renders its offline hint.
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);

  // ── Quick-capture while offline → save succeeds locally ─────────────────────
  await openQuickCapture(page); // polls until the capture listener is attached
  await expect(page.locator(".quick-capture-hint")).toContainText("Offline"); // reassures, doesn't block
  await page.locator(".quick-capture-textarea").fill(text);
  // The save resolves locally ("Saved to Inbox") instead of hanging on the dead POST.
  await saveQuickCapture(page);
  // ...and the write is QUEUED, not lost — the sync chip surfaces a pending count.
  await expectPending(page, { timeout: 10_000 });
  await page.screenshot({ path: "/tmp/pw-output/shots/offline-capture-queued.png" });

  // ── Go back online → the queued capture drains to the backend ──────────────
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  // The reconnect drain (flushPendingWrites) empties the queue → bare dot.
  await expectNoPending(page, { timeout: 15_000 });
  await expectOnline(page);

  // ── Server truth: the offline-captured note is now persisted backend-side ──
  // page.request honours setOffline, so this read only happens after we're back
  // online. Poll the server's own bootstrap until the node lands (no fixed sleep
  // on the drain round-trip).
  const captured = await pollBootstrap(
    page,
    (b) => b.nodes.find((n: { title: string }) => n.title === text),
    { message: "offline capture should sync to the backend after reconnect" },
  );
  expect(captured).toBeTruthy();

  // And it is waiting in the inbox: a top-level note carrying the inbox tag.
  expect(captured.parent_id).toBeNull();
  expect([...(captured.class_tag_ids ?? []), ...(captured.label_tag_ids ?? [])]).toContain(inboxTag);
});

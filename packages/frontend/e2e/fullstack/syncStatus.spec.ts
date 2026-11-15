// P0-4 sync status: offline edits surface a pending-writes count on the avatar
// badge; reconnecting drains it and the badge goes away.
import { test, expect } from "@playwright/test";
import { H, expectNoPending, expectOnline, expectPending } from "./helpers";


test("offline edits show a pending count; reconnect drains it", { tag: "@critical" }, async ({ page, context }) => {
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: "SyncChip note", markdown: "# chip\n\nbody" } })).json();
  await page.goto(`/?view=notes&node=${node.id}`, { waitUntil: "load" });
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await expectOnline(page);
  await expectNoPending(page);

  // Go offline and type — the autosave queues instead of sending.
  await context.setOffline(true);
  // the app flips its own `online` state on the browser event
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.locator(".cm-content").click();
  await page.keyboard.type(" offline-edit");
  // wait past the 1.5s autosave debounce so the write hits the queue
  await expectPending(page, { timeout: 10_000 });
  await page.screenshot({ path: "/tmp/pw-output/sync-chip-offline.png" });

  // Reconnect → drain → the count disappears.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectNoPending(page, { timeout: 15_000 });
  await expectOnline(page);
});

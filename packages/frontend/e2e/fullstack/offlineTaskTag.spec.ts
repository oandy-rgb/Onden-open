// Offline durability for the everyday loop: while offline, add a TASK line and
// a #word to a note's body (text, not a tag — T10). Both are ordinary body edits, so they ride the same
// autosave → sendOrQueue → queueWrite path syncStatus.spec.ts pins for plain
// edits — but here we prove the daily-driver content (a task + a tag) survives
// the round-trip: the pending count grows offline, nothing throws, and on
// reconnect it drains and the server has the task line + the tag.
//
// Offline is simulated exactly like syncStatus / offline-capture-sync:
// context.setOffline() cuts the transport, and we dispatch the window
// "offline"/"online" events because the app flips its own connection state on
// those (Playwright's setOffline doesn't synthesise them). Server reads use
// page.request (which honours setOffline), so every server assertion runs only
// AFTER we're back online.
//
// Idempotent against the shared onden_test DB: the task text + tag carry a
// per-run stamp so exactly one node/line ever matches.
import { test, expect } from "@playwright/test";
import { ready, pollBootstrap, H, expectNoPending, expectOffline, expectOnline, expectPending, pendingCount } from "./helpers";


test("offline: add a task and a #tag; pending count grows, then drains on reconnect", { tag: "@critical" }, async ({ page, context }) => {
  const stamp = Date.now();
  const taskText = `Offline task ${stamp}`;
  const tag = `offlinetag${stamp}`; // single inline-hashtag token (no spaces)

  // Seed a target note server-side BEFORE going offline, so the only writes we
  // queue are the offline body edits themselves (deterministic drain).
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Offline TaskTag ${stamp}`, markdown: "# notes\n\nbody\n" },
  })).json();

  await ready(page, `/?view=notes&node=${node.id}`);
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await expectOnline(page);
  await expectNoPending(page); // clean queue

  // ── Go offline ────────────────────────────────────────────────────────────
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);

  // ── Add a task line + an inline #tag, all offline ──────────────────────────
  // Type at the end of the body: a markdown task checkbox line, then a #tag.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End"); // move to the end of the doc
  await page.keyboard.type(`\n- [ ] ${taskText}\n#${tag}\n`);

  // The autosave debounce (~1.5s) fires while offline → the body write QUEUES
  // instead of sending → the sync chip surfaces a non-zero pending count.
  await expectPending(page, { timeout: 10_000 });
  const pending = await pendingCount(page);
  expect(pending).toBeGreaterThan(0);
  await page.screenshot({ path: "/tmp/pw-output/offline-tasktag-queued.png" });

  // Nothing threw: the editor still holds what we typed (local write succeeded).
  await expect(page.locator(".cm-content")).toContainText(taskText, { timeout: 5_000 });
  await expect(page.locator(".cm-content")).toContainText(`#${tag}`, { timeout: 5_000 });

  // ── Reconnect → the queued edits drain to the backend ──────────────────────
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectNoPending(page, { timeout: 15_000 });
  await expectOnline(page);

  // ── Server truth: the task line + the tag landed in the persisted body ─────
  // Poll the server's own bootstrap until the offline edits arrive (no fixed
  // sleep on the drain round-trip). page.request honours setOffline, so this
  // only runs after we're back online.
  const persisted = await pollBootstrap(
    page,
    (b) => {
      const n = b.nodes.find((x: { id: string }) => x.id === node.id);
      return n && n.markdown.includes(taskText) && n.markdown.includes(`#${tag}`) ? n : undefined;
    },
    { message: "offline task + tag should sync to the backend after reconnect" },
  );
  expect(persisted.markdown).toContain(`- [ ] ${taskText}`);
  expect(persisted.markdown).toContain(`#${tag}`);
});

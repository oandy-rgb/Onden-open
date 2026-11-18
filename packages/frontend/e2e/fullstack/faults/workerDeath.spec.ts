// Scenario 7 — the local-database worker dies. Playwright has no "terminate
// worker" call, but `Worker.evaluate` runs inside the dedicated worker through
// CDP, and `self.close()` there ends it exactly like a crash: the page keeps
// running with a dead worker object. (A true crash such as an OOM kill is not
// reproducible from Playwright; this is the closest faithful approximation.)
//
// Required afterwards: typed text still reaches the server, or the app says the
// local copy is unavailable, within 30 s. `worker.onerror` does not fire for a
// worker that exits silently. Since #617 every call has a deadline
// (LOCAL_DB_CALL_TIMEOUT_MS, 60 s in lib/localDb.ts): then the worker is
// replaced, the page says "Local copy temporarily unavailable" and the save goes
// on. So nothing hangs forever any more, but for that minute a save waits on the
// dead worker and nothing is shown. This test used to poll for 60 s, the same
// length as that deadline, so it passed or failed by a second or two (it
// "passed" at 63 s in the 2026-11-18 audit run); at 30 s it fails every time,
// for that reason. localDbWorkerHealth.test.ts pins the same at unit level.
import { test, expect } from "@playwright/test";
import {
  FAULTS_TAG, expectColdConvergence, openNote, seedNote, serverMarkdown, skipUnlessRequested, typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

test("7: a dead local-db worker must not hang saving", { tag: FAULTS_TAG }, async ({ page }) => {
  test.fail(true, "known open: a silently exited local-db worker is noticed only by the 60 s call timeout; until then a save waits and nothing is shown");
  test.setTimeout(120_000);
  const text = uniqueToken("worker");
  const id = await seedNote(page);
  await openNote(page, id);

  const workers = page.workers();
  const target = workers.find((w) => /localDb/i.test(w.url())) ?? workers[0];
  expect(target, "the local DB worker must be running (page.workers() was empty)").toBeTruthy();
  // The evaluation never returns: the context it ran in is gone.
  await target.evaluate(() => self.close()).catch(() => {});

  await typeInNote(page, "end", ` ${text}`);

  await expect
    .poll(async () => {
      if ((await serverMarkdown(page, id)).includes(text)) return "saved";
      const notice = page
        .locator(".toast, [role='alert'], [role='status'], .failed-write-recovery")
        .filter({ hasText: /local|storage|unavailable|device|本機/i })
        .filter({ visible: true });
      return (await notice.count()) > 0 ? "says local copy unavailable" : "hung";
    }, { timeout: 30_000, message: "within 30 s of the worker dying the text must be saved or the app must say why not" })
    .not.toBe("hung");

  await expectColdConvergence(page.context(), id, [text]);
});

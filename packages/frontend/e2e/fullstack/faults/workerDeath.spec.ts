// Scenario 7 — the local-database worker dies. Playwright has no "terminate
// worker" call, but `Worker.evaluate` runs inside the dedicated worker through
// CDP, and `self.close()` there ends it exactly like a crash: the page keeps
// running with a dead worker object. (A true crash such as an OOM kill is not
// reproducible from Playwright; this is the closest faithful approximation.)
//
// Required afterwards: typed text still reaches the server, or the app says the
// local copy is unavailable. Today `worker.onerror` only fires for load errors,
// so a worker that exits silently leaves every call pending forever and the
// write path (which asks the local queue first) hangs: fix/b2-sync-liveness.
import { test, expect } from "@playwright/test";
import {
  FAULTS_TAG, expectColdConvergence, openNote, seedNote, serverMarkdown, skipUnlessRequested, typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

test("7: a dead local-db worker must not hang saving", { tag: FAULTS_TAG }, async ({ page }) => {
  test.fail(true, "fix/b2-sync-liveness: calls to a dead worker are never rejected");
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
    }, { timeout: 60_000, message: "after the worker died the text must be saved or the app must say why not" })
    .not.toBe("hung");

  await expectColdConvergence(page.context(), id, [text]);
});

// Scenario 4 — the server answers 500 for one queued write, every time. The
// drain stops at the first failing row (to keep dependency order), so today one
// stuck row holds back every other write. Acceptable outcomes: the other note's
// edit still reaches the server, or the UI shows the stuck item with a way out
// (the recovery panel's retry / dismiss). Fixed by fix/b1-offline-queue.
import { test, expect } from "@playwright/test";
import { FAULTS_TAG, expectColdConvergence, expectServerHas, openNote, seedNote, serverMarkdown, skipUnlessRequested, typeInNote, uniqueToken } from "./faultKit";
import { selectNodeByTitle } from "../helpers";

test.beforeEach(skipUnlessRequested);

test("4: one write failing with 500 must not trap the others", { tag: FAULTS_TAG }, async ({ page }) => {
  test.fail(true, "fix/b1-offline-queue: the drain breaks at the first 5xx row and never reaches later writes");
  test.setTimeout(120_000);
  const stuckText = uniqueToken("stuck");
  const otherText = uniqueToken("other");
  const stuckId = await seedNote(page);
  const otherId = await seedNote(page);
  const otherTitle = (await (await page.request.get(`/api/nodes/${otherId}`)).json()).title as string;

  await page.route(`**/api/nodes/${stuckId}`, (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
  });

  await openNote(page, stuckId);
  await typeInNote(page, "end", ` ${stuckText}`);
  // Switching notes saves the open draft first (the stuck one) and then edits the other.
  await selectNodeByTitle(page, otherTitle);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await typeInNote(page, "end", ` ${otherText}`);

  await expect
    .poll(async () => {
      if ((await serverMarkdown(page, otherId)).includes(otherText)) return "other write landed";
      const recovery = page.locator(".failed-write-recovery");
      if ((await recovery.count()) > 0 && (await recovery.getByRole("button").count()) > 0) return "stuck item with a way out";
      return "trapped";
    }, { timeout: 60_000, message: "other write must land, or the stuck item must be shown with a way out" })
    .not.toBe("trapped");

  // Nothing is silently dropped: once the server recovers, the stuck text lands too.
  await page.unroute(`**/api/nodes/${stuckId}`);
  await expectColdConvergence(page.context(), stuckId, [stuckText]);
  await expectServerHas(page, otherId, [otherText]);
});

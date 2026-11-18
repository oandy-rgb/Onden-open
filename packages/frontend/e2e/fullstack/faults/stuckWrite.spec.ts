// Scenario 4 — the server answers 500 for one queued write, every time. The
// drain stops at the first failing row (to keep dependency order), so one stuck
// row holds back every other write, also writes to other notes. Acceptable
// outcomes: the other note's edit still reaches the server, or the UI shows the
// stuck item with a way out. #616 added that way out (the sync status' "move to
// recovery"), but only once the head failed STUCK_AFTER_ATTEMPTS (8) times on
// the retry ladder (2, 5, 15, 60, 60… s): about 4.4 minutes. Still open; the
// same is pinned on fake timers in writeQueue.test.ts.
import { test, expect } from "@playwright/test";
import { FAULTS_TAG, expectColdConvergence, expectServerHas, openNote, seedNote, serverMarkdown, skipUnlessRequested, typeInNote, uniqueToken } from "./faultKit";
import { selectNodeByTitle } from "../helpers";

test.beforeEach(skipUnlessRequested);

test("4: one write failing with 500 must not trap the others", { tag: FAULTS_TAG }, async ({ page }) => {
  test.fail(true, "known open: the drain stops at the first 5xx row, and the stuck notice comes only after 8 tries (~4.4 min)");
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

  // The way out today (#616) is the sync status' "Move to recovery". On a computer the detailed status is in the
  // account dialog (the avatar; AppTopbar.tsx `account-sync`), on a phone in the strip above the bottom bar.
  const wayOut = async (): Promise<boolean> => {
    if (!(await page.locator(".account-dialog").isVisible())) await page.locator(".user-chip").click();
    return page.locator(".sync-trouble").getByRole("button", { name: /^(Move to recovery|移到復原區)$/ }).filter({ visible: true }).isVisible();
  };
  await expect
    .poll(async () => {
      if ((await serverMarkdown(page, otherId)).includes(otherText)) return "other write landed";
      return (await wayOut()) ? "stuck item with a way out" : "trapped";
    }, { timeout: 60_000, message: "other write must land, or the stuck item must be shown with a way out" })
    .not.toBe("trapped");
  await page.keyboard.press("Escape");

  // Nothing is silently dropped: once the server recovers, the stuck text lands too.
  await page.unroute(`**/api/nodes/${stuckId}`);
  await expectColdConvergence(page.context(), stuckId, [stuckText]);
  await expectServerHas(page, otherId, [otherText]);
});

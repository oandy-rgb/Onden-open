// Feature-audit deepening (2026-10-07): HIST-05 — the open version window
// keeps its preview target when later saves merge into the session row, the
// Current entry shows the live draft, and going offline keeps the open
// preview and disables Restore. (Opened from the header's note-history-link since 2026-10-18, c38ff179.)
import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";


test("HIST-05: preview target stable across merged saves and offline", async ({ page }) => {
  test.setTimeout(120_000);
  const s = Date.now();
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `H05 ${s}`, markdown: `FIRST ${s}` } })).json();
  await page.waitForTimeout(1100); // the two saves are a second apart, so they are two moments of the note's history
  await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: `SECOND ${s}` } });
  await ready(page, `/?view=notes&node=${n.id}`);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" draft-typed");
  const versionCount = async () => (await (await page.request.get(`/api/nodes/${n.id}/versions`, H)).json()).length;
  const versionsBefore = await versionCount();

  await page.locator(".note-history-link").first().click();
  await expect(page.locator(".nh")).toBeVisible();
  const slider = page.locator(".nh").getByRole("slider");
  await slider.press("Home");
  const pane = page.locator(".nh-paper");
  await expect(pane).toContainText(`FIRST ${s}`);
  // What is listed when the window opens: the saved versions and the live "Current" entry.
  const rowsAtOpen = await page.locator(".nh-versions .nh-row").count();

  // More saves land (same actor, same session → merge into the newest row, docs/architecture/history-api.md: 修改次數).
  for (const i of [1, 2, 3]) await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: `SECOND ${s} more${i}` } });
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${n.id}`, H)).json()).markdown as string).toContain("more3");
  expect(await versionCount(), "saves by the same actor in the same session merge into one version").toBe(versionsBefore);
  // The version being looked at stays put while later saves land (decisions-restore-history.md, batch 5: 已開啟的版本預覽擁有內容快照).
  await expect(pane).toContainText(`FIRST ${s}`);
  expect(await slider.getAttribute("aria-valuenow"), "and stays selected").toBe("0");

  // Current entry shows the live draft, not the server copy (decisions-restore-history.md, batch 5: Current 顯示即時草稿).
  await slider.press("End");
  await expect(pane).toContainText("draft-typed");
  await slider.press("Home");

  // Offline: the open window keeps the list and the preview it opened with (decisions-restore-history.md, batch 5: 完整視窗保留開啟時的版本列表),
  // and restoring is refused (the Restore button is disabled; restore is a write that needs the server, lib/useVersionRestore).
  await page.context().setOffline(true);
  await expect(pane, "the preview is kept offline").toContainText(`FIRST ${s}`);
  expect(await page.locator(".nh-versions .nh-row").count(), "the list is kept offline").toBe(rowsAtOpen);
  await expect(page.locator(".nh-actions .ui-btn--primary"), "Restore is not offered offline").toBeDisabled();
  await page.context().setOffline(false);
  // Back online the window is still open, and the typed draft reached the server beside the saves that landed meanwhile: two sides that
  // only added text to the same line both stay (docs/decisions/body-three-way-merge.md, exception of 2026-11-17).
  await expect(page.locator(".nh")).toHaveCount(1);
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${n.id}`, H)).json()).markdown as string, { timeout: 30_000 }).toContain("draft-typed");
  const server = (await (await page.request.get(`/api/nodes/${n.id}`, H)).json()).markdown as string;
  expect(server, "and the saves that landed meanwhile are kept").toContain("more3");
});

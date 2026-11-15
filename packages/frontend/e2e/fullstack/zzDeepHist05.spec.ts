// Feature-audit deepening (2026-10-07): HIST-05 — the open version window
// keeps its preview target when later saves merge into the session row, the
// Current entry shows the live draft, and going offline (which clears the
// inspector's version list) keeps the open preview.
import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";


test("HIST-05: preview target stable across merged saves and offline", async ({ page }) => {
  test.setTimeout(120_000);
  const s = Date.now(); const out: Record<string, string> = {};
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `H05 ${s}`, markdown: `FIRST ${s}` } })).json();
  await page.waitForTimeout(1100);
  await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: `SECOND ${s}` } });
  await ready(page, `/?view=notes&node=${n.id}`);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" draft-typed");
  const versionsBefore = (await (await page.request.get(`/api/nodes/${n.id}/versions`, H)).json()).length;

  await page.locator(".ov-history-open").first().click();
  await expect(page.locator(".nh")).toBeVisible();
  const slider = page.locator(".nh").getByRole("slider");
  await slider.press("Home");
  const pane = page.locator(".nh-paper");
  await expect(pane).toContainText(`FIRST ${s}`);
  out.selectedOldest = "FIRST";

  // More saves land (same actor, same session → merge into the newest row).
  for (const i of [1, 2, 3]) await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: `SECOND ${s} more${i}` } });
  await page.waitForTimeout(2500);
  const versionsAfter = (await (await page.request.get(`/api/nodes/${n.id}/versions`, H)).json()).length;
  out.merge = `versions ${versionsBefore}→${versionsAfter}`;
  out.previewStillOldest = String((await pane.innerText()).includes(`FIRST ${s}`));
  out.selectionStill = String((await slider.inputValue()) === "0");

  // Current entry shows the live draft, not the server copy.
  await slider.press("End");
  out.currentShowsDraft = String((await pane.innerText()).includes("draft-typed"));
  await slider.press("Home");

  // Offline: inspector list clears; the open window keeps its preview; restore refuses or queues clearly.
  await page.context().setOffline(true);
  await page.waitForTimeout(2000);
  out.offlinePreviewKept = String((await pane.innerText()).includes(`FIRST ${s}`));
  out.offlineEntries = String(await page.locator(".nh-versions .nh-row").count());
  const restore = page.locator(".nh-actions .ui-btn--primary");
  out.offlineRestore = `disabled=${await restore.isDisabled()}`;
  if (!(await restore.isDisabled())) {
    await restore.click();
    await page.waitForTimeout(1500);
    out.offlineRestore += ` modalOpen=${await page.locator(".nh").count()} notice=${JSON.stringify(await page.locator(".nh-notice").innerText().catch(() => ""))}`;
  }
  await page.context().setOffline(false);
  await page.waitForTimeout(3000);
  out.afterReconnect = `modalOpen=${await page.locator(".nh").count()} server=${JSON.stringify(((await (await page.request.get(`/api/nodes/${n.id}`, H)).json()).markdown as string).slice(0, 30))}`;
  console.log(`AUDIT HIST-05 ${JSON.stringify(out)}`);
});

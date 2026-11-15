// NOTE-03 follow-up (2026-10-08): after the start-up check has settled, go
// offline and (1) wait, (2) quick-capture a note. When does the
// "Checking your workspace" lock appear, and does it lift while offline?
import { test } from "@playwright/test";
import { H, ready, openQuickCaptureByHotkey, syncLabel } from "../fullstack/helpers";

test("NOTE-03b: workspace lock around offline capture", async ({ page, context }) => {
  test.setTimeout(120_000);
  const out: Record<string, unknown> = {};
  const gate = page.getByText("Checking your workspace", { exact: false });
  if (process.env.WITH_TAG) await page.request.post("/api/tags/import", { ...H, data: { name: `n03b${Date.now()}`, fields: [] } });
  await ready(page, "/?view=notes");
  for (let i = 0; i < 60 && await gate.isVisible().catch(() => false); i++) await page.waitForTimeout(500);
  await page.waitForTimeout(3000);
  out.beforeOffline = await gate.isVisible();
  await context.setOffline(true);
  await page.waitForTimeout(Number(process.env.OFF_WAIT ?? 5000));
  out.offline5sNoAction = await gate.isVisible();
  await openQuickCaptureByHotkey(page);
  await page.locator(".quick-capture-textarea").fill(`LockProbe ${Date.now()}`);
  await page.locator(".quick-capture-textarea").press("Control+Enter");
  const samples: string[] = [];
  for (let i = 0; i < 20; i++) { samples.push(await gate.isVisible() ? "L" : "-"); await page.waitForTimeout(500); }
  out.after10sOffline = samples.join("");
  out.sync = (await syncLabel(page)).replace(/\s+/g, " ").slice(0, 60);
  await context.setOffline(false);
  const t0 = Date.now();
  while (await gate.isVisible() && Date.now() - t0 < 20_000) await page.waitForTimeout(250);
  out.unlockAfterOnlineMs = Date.now() - t0;
  console.log("NOTE03B " + JSON.stringify(out, null, 2));
});

import { test, expect } from "@playwright/test";
import { ready, openQuickCaptureByHotkey } from "./helpers";

// Split out of dailyDriver.spec.ts so the WebKit scan can run it on the desktop project only (webkitScanSpecs.ts):
// it asserts desktop-only chrome (`.app-topbar`), which the phone layout does not have.
// 1b — Desktop has no capture button (the QuickCapture FAB is mobile-only,
// display:none >900px): Ctrl+Shift+N is the way in, and the topbar says nothing
// else about it.
test("desktop hotkey opens quick capture; the topbar has no capture button", { tag: "@critical" }, async ({ page }) => {
  await ready(page, "/?view=notes");
  await expect(page.locator(".app-topbar")).toBeVisible();
  await expect(page.locator(".app-topbar").getByRole("button", { name: /^(捕捉|Capture)$/ })).toHaveCount(0);
  await openQuickCaptureByHotkey(page);
  await expect(page.locator(".quick-capture-textarea")).toBeVisible();
});

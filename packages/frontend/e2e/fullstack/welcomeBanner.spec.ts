// ⑨ onboarding — a first-run user lands on a blank note with no orientation.
// A one-time, dismissible welcome banner names the core loop and offers the
// first action. The suite's global-setup pre-dismisses it (so it never overlays
// other specs); here we re-enable it (addInitScript clears the dismissal the
// stored auth state carries) to verify show → act → persistent-dismiss.
//
// The banner is for an EMPTY workspace: once there are notes beyond day notes
// it stays hidden even without the localStorage flag (a new device or URL
// starts without it). The shared e2e workspace always has notes, so the
// show/act/layout checks run only on a fresh stack and skip here.
import { test, expect } from "@playwright/test";
import { ready, renderSettled, workspaceIsNew } from "./helpers";

test("a workspace that already has notes never shows the welcome, even without the flag", async ({ page }) => {
  test.skip(await workspaceIsNew(page), "needs a workspace with notes");
  await page.addInitScript(() => localStorage.removeItem("onden.welcomeDismissed"));
  await ready(page, "/?view=notes");
  await expect(page.locator(".obsidian-sidebar").first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.locator(".welcome-banner")).toHaveCount(0);
});

test("welcome banner is hidden by default (global-setup dismissed it)", async ({ page }) => {
  await ready(page, "/?view=notes");
  await expect(page.locator(".welcome-banner")).toHaveCount(0);
});

test("first-run banner shows; dismissing sets the persistent flag", async ({ page }) => {
  test.skip(!(await workspaceIsNew(page)), "the welcome only shows in an empty workspace");
  await page.addInitScript(() => localStorage.removeItem("onden.welcomeDismissed"));
  await ready(page, "/?view=notes");

  const banner = page.locator(".welcome-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText("Welcome to Onden");

  await banner.locator(".welcome-banner-dismiss").click();
  await expect(banner).toHaveCount(0);
  // The account's list of seen hints now holds it → no nag, on any device.
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
    .some(([key, value]) => key.includes("onden.hintsSeen") && value.includes("welcome")))).toBe(true);
});

test("'Create your first note' acts and dismisses the banner", async ({ page }) => {
  test.skip(!(await workspaceIsNew(page)), "the welcome only shows in an empty workspace");
  await page.addInitScript(() => localStorage.removeItem("onden.welcomeDismissed"));
  await ready(page, "/?view=notes");
  await expect(page.locator(".welcome-banner")).toBeVisible({ timeout: 15_000 });

  await page.locator(".welcome-banner-action", { hasText: "Write your first note" }).click();
  // Acting on it dismisses it (and opens a fresh "Untitled" note to type into,
  // replacing the daily note it landed on).
  await expect(page.locator(".welcome-banner")).toHaveCount(0);
  await expect(page.locator(".obsidian-title-input")).toHaveValue("Untitled");
});

for (const theme of ["light", "dark"]) {
  test(`welcome card stays inside the sidebar boundary (${theme})`, async ({ page }, testInfo) => {
    test.skip(!(await workspaceIsNew(page)), "the welcome only shows in an empty workspace");
    await page.addInitScript((mode) => {
      localStorage.removeItem("onden.welcomeDismissed");
      localStorage.setItem("onden.locale", "zh-TW");
      localStorage.setItem("theme", mode);
    }, theme);
    await ready(page, "/?view=notes");
    const workspace = page.locator(".overview-workspace");
    const sidebar = workspace.locator(":scope > .obsidian-sidebar");
    const banner = page.locator(".welcome-banner");
    await expect(banner).toBeVisible();
    await expect(page.locator(".membership-gate")).toHaveCount(0);
    await renderSettled(page);
    await page.screenshot({ path: testInfo.outputPath(`welcome-${theme}-1280.png`) });

    const rail = (await sidebar.boundingBox())!;
    const card = (await banner.boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(rail.x + rail.width + 16);
    // The separator belongs to the actual rail. A background line at a fixed
    // x coordinate can pass through the card despite correct element bounds.
    await expect(workspace).toHaveCSS("background-image", "none");
    await expect(sidebar).toHaveCSS("border-inline-end-width", "1px");
    await page.getByRole("button", { name: "收起側欄", exact: true }).click();
    await expect(sidebar).toBeHidden();
    await expect(banner).toBeInViewport();
    await expect(workspace).toHaveCSS("background-image", "none");
    await page.getByRole("button", { name: "顯示側欄", exact: true }).click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS("border-inline-end-width", "1px");
  });
}

test("welcome actions remain inside narrow phone viewports", async ({ page }, testInfo) => {
  // A fixture note would make the workspace non-new and hide the banner.
  test.skip(!(await workspaceIsNew(page)), "the welcome only shows in an empty workspace");
  await page.addInitScript(() => {
    localStorage.removeItem("onden.welcomeDismissed");
    localStorage.setItem("onden.locale", "zh-TW");
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await ready(page, "/?view=notes");
    const banner = page.locator(".welcome-banner");
    await expect(banner).toBeVisible();
    await expect(page.locator(".membership-gate")).toHaveCount(0);
    for (const control of await banner.locator("button").all()) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await renderSettled(page);
    await page.screenshot({ path: testInfo.outputPath(`welcome-${width}.png`) });
  }
});

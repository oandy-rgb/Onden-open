// SCREENSHOT-ONLY: drive the REAL first-run "Build your first website" button in
// WelcomeBanner (the shipped dogfood onboarding) end to end and capture what a
// first-run user actually sees. firstRunBuildSite.spec.ts asserts the SSR pipeline
// via the API (its scope note predates the button); this one clicks the button.
// Shots → /tmp/pw-output/shots (mirrored to /tmp/pw-host-out/shots by run.sh).
import { test, expect } from "@playwright/test";
import { ready, workspaceIsNew } from "./helpers";

const SHOTS = "/tmp/pw-output/shots";

test("first-run: Build your first website button flow", async ({ page }) => {
  test.skip(!(await workspaceIsNew(page)), "the welcome only shows in an empty workspace");
  // Re-enable the welcome banner the stored auth state dismissed.
  await page.addInitScript(() => localStorage.removeItem("onden.welcomeDismissed"));
  await ready(page, "/?view=notes");

  const banner = page.locator(".welcome-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/dogfood-1-welcome.png`, fullPage: true });

  // Click the real "Build your first website" action.
  const buildBtn = banner.getByRole("button", { name: /Build your first website/i });
  await expect(buildBtn).toBeVisible();
  await buildBtn.click();

  // It installs + publishes the intro notes + applies the site chrome, then
  // surfaces "Your site is live" + the "View your published site →" link.
  await expect(banner.getByText(/Your site is live/i)).toBeVisible({ timeout: 30_000 });
  const siteLink = banner.getByRole("link", { name: /View your published site/i });
  await expect(siteLink).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dogfood-2-site-live.png`, fullPage: true });

  // Follow the published-site URL and capture what a visitor lands on.
  const href = await siteLink.getAttribute("href");
  expect(href, "site link href").toBeTruthy();
  await page.goto(href!, { waitUntil: "load" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/dogfood-3-published-site.png`, fullPage: true });
  console.error(`[DOGFOOD-SHOTS] published site href=${href}`);
});

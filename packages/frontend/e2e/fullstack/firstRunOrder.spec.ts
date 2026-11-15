// First-run order: a stranger (no session) must meet the LOGIN gate before the
// OPFS-vs-folder storage picker — you shouldn't answer a storage question
// before you've seen what the app is. Regression for the reordered gating.
import { test, expect } from "@playwright/test";

// A clean context: NO storageState, so we're an unauthenticated stranger.
test.use({ storageState: { cookies: [], origins: [] } });

test("an unauthenticated stranger sees the login gate, not the storage picker", async ({ page }) => {
  await page.goto("/?view=notes", { waitUntil: "load" });
  // the login card (with the Onden mark + a password field) is what greets them
  await expect(page.locator(".login-gate .login-logo")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".login-input[type='password']")).toBeVisible();
  // the storage picker is gated behind auth now — not shown to a stranger
  await expect(page.getByText("Use browser storage", { exact: false })).toHaveCount(0);
});

test("first-contact follows the locale: the login gate reads zh-TW", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("onden.locale", "zh-TW"));
  await page.goto("/?view=notes", { waitUntil: "load" });
  await expect(page.locator(".login-gate .login-logo")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".login-submit", { hasText: "登入" })).toBeVisible();
  await expect(page.locator(".login-input[type='email']")).toHaveAttribute("placeholder", "電子郵件");
});

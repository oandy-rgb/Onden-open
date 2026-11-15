// i18n layer B regression: the Settings Language select flips the app chrome
// between en and zh-TW LIVE (useSyncExternalStore re-render, no reload).
// Screenshots (i18n-en.png / i18n-zh.png) land in the output dir for eyes.
import { test, expect } from "@playwright/test";
import { openSettingsFromAvatar } from "./helpers";

test("language setting switches app chrome to zh-TW live", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("onden.locale", "system"));
  await page.reload();
  await openSettingsFromAvatar(page, "Language");
  await expect(page.locator(".settings-modal")).toBeVisible();
  await page.screenshot({ path: "/tmp/pw-output/i18n-en.png" });

  // Switch Language → Traditional Chinese; chrome should flip without reload.
  const langRow = page.locator(".settings-row", { hasText: "Language" }).first();
  await expect(langRow).toBeVisible();
  await langRow.locator("select").selectOption("zh-TW");
  await expect(page.locator(".settings-title")).toHaveText("設定");
  await expect(page.locator(".settings-nav-item[data-tab=language]")).toContainText("語言");
  await page.screenshot({ path: "/tmp/pw-output/i18n-zh.png" });

  // And back to English.
  const langRowZh = page.locator(".settings-row", { hasText: "語言" }).first();
  await langRowZh.locator("select").selectOption("en");
  await expect(page.locator(".settings-title")).toHaveText("Settings");
});

import { test, expect } from "@playwright/test";
import { phoneNotesHome, scrollToSidebarRow, seedNodes } from "./helpers";

// 手機「筆記」首頁：原本樹下有「最近」補滿畫面；業主 2026-10-23 決定拔掉（「把最近拔掉吧 沒啥用」，
// c93b93d40 #587）：樹下不再有「最近」，清單直接放在頁面底色上。這裡守住現在的樣子：沒有「最近」，
// 筆記一列一列在樹裡，點一列開啟那篇筆記。
test.use({ viewport: { width: 390, height: 844 } });

test("mobile: notes home has no 最近 under the tree; a row opens its note", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const ids = await seedNodes(page, 6, { title: (i) => `Recent ${stamp} ${i}`, token: `recent-${stamp}` });
  // /?view=notes opens the landing note (today's) full screen; the notes home is one step back.
  await phoneNotesHome(page);

  await expect(page.locator(".obsidian-sidebar").getByRole("heading", { name: /^(Recent|最近)$/ })).toHaveCount(0);
  const rows = page.locator(".obsidian-sidebar [data-sb-id] .obsidian-page-button");
  await expect(rows.first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("phone-home.png") });

  // A row of the tree opens its note full screen (‹ back to the list).
  // Other writes to the shared workspace re-render the list now and then: retry a short tap until one lands.
  await expect(async () => {
    const row = await scrollToSidebarRow(page, ids[0]);
    await row.locator(".obsidian-page-button").click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.locator(".overview-mobile-tabs .omt-back")).toBeVisible();
  await expect(page.locator(".obsidian-title-input").first()).toHaveValue(`Recent ${stamp} 0`);
});

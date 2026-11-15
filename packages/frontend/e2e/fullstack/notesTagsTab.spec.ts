import { test, expect } from "@playwright/test";
import { phoneNotesHome } from "./helpers";

// 手機筆記首頁：分頁「標籤 | 筆記 | 收件匣」，預設「筆記」，記住上次選的分頁；
// 標籤分頁只列標籤階層（▸ 只展開子標籤），筆記首頁沒有 # 標籤 chips。
// 視窗為手機尺寸模擬，不是真機驗收。
test.use({ viewport: { width: 390, height: 844 } });


for (const theme of ["light", "dark"] as const) {
  test(`mobile notes home: tags tab (${theme})`, { tag: "@critical" }, async ({ page }, info) => {
    await phoneNotesHome(page);
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const tabs = page.locator(".obsidian-sidebar .sidebar-tab");
    await expect(tabs).toHaveText([/標籤|Tags/, /筆記|Notes/, /收件匣|Inbox/]);
    await expect(page.locator(".sidebar-tab.active")).toHaveText(/筆記|Notes/);

    await tabs.first().click();
    await expect(page.locator(".sb-tagtree")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath(`notes-tags-tab-${theme}.png`) });

    // Remembered per device across a reload; put it back for the next run.
    await phoneNotesHome(page);
    await expect(page.locator(".sidebar-tab.active")).toHaveText(/標籤|Tags/);
    await page.locator(".obsidian-sidebar .sidebar-tab").nth(1).click();
  });
}

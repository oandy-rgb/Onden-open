// i18n layer B — sidebar + editor chrome localizes to zh-TW (labels via t(),
// reactive through useT()). English (the default e2e locale) is unchanged
// because the literal IS the dictionary key.
import { test, expect } from "@playwright/test";
import { ready, openSidebarSearch, H } from "./helpers";


test("sidebar + editor chrome reads zh-TW under the zh-TW locale", async ({ page }) => {
  const stamp = Date.now();
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `Chrome ${stamp}`, markdown: "body" } })).json();
  await page.addInitScript(() => localStorage.setItem("onden.locale", "zh-TW"));
  await ready(page, `/?view=notes&node=${node.id}`);
  await page.locator(".cm-content").first().waitFor({ timeout: 20_000 });

  await expect(page.locator(".sidebar-tab", { hasText: "筆記" }).first()).toBeVisible();
  await expect(page.locator(".sidebar-tab", { hasText: "收件匣" })).toBeVisible();
  await expect(await openSidebarSearch(page)).toHaveAttribute("placeholder", /搜尋/);
  await expect(page.locator(".sb-bar-btn", { hasText: "排序" })).toBeVisible();
  // 編輯｜並排｜預覽 sit beside ⋯ as icons since 2026-11-02 (changes/2026-11-02-note-mode-icons.md);
  // each icon is named by its translated label.
  const modes = page.getByRole("radiogroup", { name: "顯示", exact: true });
  await expect(modes.getByRole("radio", { name: "編輯", exact: true })).toBeVisible();
  await expect(modes.getByRole("radio", { name: "並排", exact: true })).toBeVisible();
  await expect(modes.getByRole("radio", { name: "預覽", exact: true })).toBeVisible();
});

test("English locale (default) keeps the English chrome — no regression", async ({ page }) => {
  const stamp = Date.now();
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `ChromeEn ${stamp}`, markdown: "body" } })).json();
  await ready(page, `/?view=notes&node=${node.id}`);
  await page.locator(".cm-content").first().waitFor({ timeout: 20_000 });
  await expect(page.locator(".sidebar-tab", { hasText: "Notes" }).first()).toBeVisible();
  const modes = page.getByRole("radiogroup", { name: "Display", exact: true });
  await expect(modes.getByRole("radio", { name: "Edit", exact: true })).toBeVisible();
  await expect(modes.getByRole("radio", { name: "Side by side", exact: true })).toBeVisible();
  await expect(modes.getByRole("radio", { name: "Preview", exact: true })).toBeVisible();
});

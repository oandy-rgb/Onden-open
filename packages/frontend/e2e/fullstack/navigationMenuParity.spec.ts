import { test, expect, type Locator, type Page } from "@playwright/test";
import { openNavDestination, openQuickCaptureByHotkey, ready, reloadColdStart, renderSettled, BASE, sidebarSearch, closeSideBySide, H } from "./helpers";

const WRITE = H;
// The nav follows the imported modules (hooks/shellNavigation): the
// core pages 筆記 任務 關係圖 always show (歷史 is in 更多; 標籤 is no page
// of its own any more); each imported module with a page follows them on
// desktop, folding into 「更多 ▾」 when the bar is narrow. The phone bar is
// 筆記 ＋ 任務 更多; its More sheet lists every other page, grouped as the nav
// editor does (groupDestinations): 時間 (日記, 歷史 by their order), 整理
// (the other core pages), then 功能 (the imported features) ending with
// 「管理功能」. Search is not a page: on a phone it is the top bar's search
// button (b4829e18), not a More row.
const MOBILE_MORE_LEADING_GROUPS = [
  { label: "時間", items: ["日記", "歷史"] },
  { label: "整理", items: ["關係圖"] },
];

test.beforeEach(async ({ page }) => {
  const target = new URL(BASE);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
  expect(["5099", "5100"], "navigation fixtures require an isolated onden_test stack").toContain(target.port);
  // A right pane folds the notes sidebar away, hiding the list search this spec drives.
  await closeSideBySide(page.request, page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("navigation-menu-parity-started")) return;
    sessionStorage.setItem("navigation-menu-parity-started", "1");
    localStorage.setItem("onden.locale", "zh-TW");
    localStorage.setItem("theme", "dark");
    localStorage.setItem("onden.welcomeDismissed", "1");
    localStorage.setItem("onden.focusMode", "0");
    localStorage.setItem("onden.inspectorOpen", "0");
    localStorage.setItem("onden.inspectorCollapsed", "0");
  });
});

async function withNote(page: Page, run: (note: { id: string; title: string; bodyToken: string }) => Promise<void>) {
  const bodyToken = `menuBodySearch${Date.now()}`;
  const response = await page.request.post("/api/nodes", {
    ...WRITE,
    data: { title: `驗收-選單一致-${Date.now()}`, markdown: `只切換導覽與開啟捕捉，不改動這份正文。 ${bodyToken}` },
  });
  expect(response.status()).toBe(201);
  const note = await response.json() as { id: string; title: string };
  try {
    await run({ ...note, bodyToken });
  } finally {
    const deleted = await page.request.delete(`/api/nodes/${note.id}`, WRITE);
    expect(deleted.ok(), "clean only this fixture through the normal delete API").toBe(true);
  }
}

async function expectInsideViewport(element: Locator, width: number) {
  const bounds = (await element.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
}

async function expectInsidePanel(element: Locator, panel: Locator) {
  const bounds = (await element.boundingBox())!;
  const outer = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(outer.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(bounds.y).toBeGreaterThanOrEqual(outer.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(outer.y + outer.height);
}

async function expectGroupedRows(panel: Locator, groupSelector: string, itemSelector: string,
  expectedGroups: { label: string; items: string[] }[], { leading = false } = {}) {
  // The sheet slides up: measure once it has stopped, or two rows read a
  // frame apart look like they overlap.
  await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const groups = panel.locator(groupSelector);
  // `leading`: only the first groups are fixed (the rest follow the imports).
  if (!leading) await expect(groups).toHaveCount(expectedGroups.length);
  for (const [index, expected] of expectedGroups.entries()) {
    const group = groups.nth(index);
    await expect(group).toHaveAttribute("role", "group");
    await expect(group).toHaveAccessibleName(expected.label);
    const items = group.locator(itemSelector);
    await expect(items).toHaveText(expected.items);
    if (expected.items.length < 2) continue;
    // One column of full-width rows (a6ee343b replaced the two-column grid):
    // the second choice sits under the first, left-aligned, not overlapping.
    const first = (await items.nth(0).boundingBox())!;
    const second = (await items.nth(1).boundingBox())!;
    expect(second.x, `${expected.label}: choices share one column`).toBeCloseTo(first.x, 0);
    expect(first.y + first.height, `${expected.label}: rows do not overlap`).toBeLessThanOrEqual(second.y);
  }
}

async function expectNoOverflow(page: Page, width: number) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function expectToolbarFits(page: Page, width: number) {
  await renderSettled(page);
  const bar = page.locator(".app-topbar");
  // The left group's last item is the navigation row (no capture button: Ctrl+Shift+N).
  const daily = (await bar.locator(".app-topbar-left").boundingBox())!;
  const right = (await bar.locator(".app-topbar-right").boundingBox())!;
  // Fixed-width toolbar groups can overlap without changing page scrollWidth.
  // Check the actual boundary between the last left action and right controls.
  expect(daily.x + daily.width, `toolbar groups must not overlap at ${width}px`).toBeLessThanOrEqual(right.x);
  for (const control of await bar.getByRole("button").filter({ visible: true }).all()) {
    await expectInsideViewport(control, width);
  }
  await expectNoOverflow(page, width);
}

test("desktop shows the core pages and the imported modules' pages; the phone More sheet opens the shared destinations", async ({ page }, testInfo) => {
  await withNote(page, async (note) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await ready(page, `/?view=notes&node=${note.id}`);
    await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
    const primary = page.locator(".app-primary-nav");
    for (const name of ["筆記", "任務", "關係圖"]) {
      await expect(primary.getByRole("button", { name, exact: true })).toHaveCount(1);
    }
    // Tags is no longer a page of its own (useUiMode: the tags drawer retired):
    // the tag list is in the notes sidebar, a phone's Notes home 「標籤｜筆記｜收件匣」.
    await expect(primary.getByRole("button", { name: "標籤", exact: true })).toHaveCount(0);
    // 閱讀 (RSS imported) is in the bar or, when it does not fit, under 更多 ▾.
    const reading = primary.getByRole("button", { name: "閱讀", exact: true });
    const desktopMore = primary.getByRole("button", { name: "更多", exact: true });
    expect(await reading.count() + await desktopMore.count()).toBeGreaterThanOrEqual(1);
    const mainSearch = page.locator(".app-topbar .palette-trigger").filter({ visible: true });
    await expect(mainSearch).toHaveCount(1);
    await mainSearch.click();
    await expect(page.locator(".palette-input-wrap input")).toBeFocused();
    await page.locator(".palette-input-wrap input").fill(note.title);
    await page.locator(".palette-item").filter({ has: page.getByText(note.title, { exact: true }) }).click();
    await expect(page.locator(".palette-modal")).toBeHidden();
    await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
    // The bar never wraps or scrolls.
    await expectNoOverflow(page, 1280);
    await expect.poll(() => primary.evaluate((nav) => nav.scrollWidth <= nav.clientWidth + 1)).toBe(true);
    await expect(primary.getByRole("button", { name: "關係圖", exact: true })).toHaveCount(1);
    await renderSettled(page);
    await page.screenshot({ path: testInfo.outputPath("topbar-dark-desktop-1280.png") });

    // 日記 is an imported module's page: in the bar, or under 「更多 ▾」 when
    // the bar is narrow (the Tags page's feature cards went in 1a18dc00). 白板
    // used to be checked here; it is a view of a note now (a note's 「白板」
    // tab, #812 #823), with no destination or board list of its own.
    await openNavDestination(page, "日記");
    await expect(page).toHaveURL((url) => url.searchParams.get("view") === "daily");

    await primary.getByRole("button", { name: "關係圖", exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("view") === "graph");

    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await ready(page, `/?view=notes&node=${note.id}&lens=editor`);
      const mobileNav = page.locator(".mobile-bottom-nav");
      // Never edited, the bar is 筆記 · ＋ · 任務 · 更多 (lib/navLayout
      // DEFAULT_PHONE_PINS, the ＋ split in by splitAroundCapture): no module
      // (閱讀…) takes a slot, and 標籤 is the Notes home's first tab now.
      await expect(mobileNav.getByRole("button")).toHaveText(["筆記", "", "任務", "更多"]);
      await expect(mobileNav.getByRole("button", { name: "閱讀", exact: true })).toHaveCount(0);
      await expect(page.locator(".app-topbar .palette-trigger")).toBeHidden();
      await expect(page.locator(".app-topbar").getByRole("button", { name: /^(捕捉|Capture)$/ })).toHaveCount(0);
      await mobileNav.getByRole("button", { name: "更多", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "更多", exact: true });
      const mobileItems = sheet.locator(".mobile-more-grid button");
      await expect(sheet).toBeVisible();
      // The other core pages, then 功能 (the imported features, RSS among them).
      const groups = sheet.locator(".mobile-more-grid .mobile-more-group");
      for (const [index, expected] of MOBILE_MORE_LEADING_GROUPS.entries()) {
        await expect(groups.nth(index)).toHaveAccessibleName(expected.label);
        await expect(groups.nth(index).locator(".mobile-more-items button")).toHaveText(expected.items);
      }
      // 「RSS 閱讀」 is simply 「閱讀」 (2026-10-30).
      await expect(sheet.getByRole("group", { name: "功能", exact: true }).getByRole("button", { name: "閱讀", exact: true })).toHaveCount(1);
      await expect(sheet.getByRole("button", { name: "標籤", exact: true })).toHaveCount(0);
      await expectGroupedRows(sheet, ".mobile-more-grid .mobile-more-group", ".mobile-more-items button", MOBILE_MORE_LEADING_GROUPS, { leading: true });
      await expectInsideViewport(sheet, width);
      for (const item of await mobileItems.all()) {
        await item.scrollIntoViewIfNeeded();
        await expect(item).toBeVisible();
        await expectInsideViewport(item, width);
        await expectInsidePanel(item, sheet);
      }
      // The sheet's ✕ is ui/SheetHeader's.
      const close = sheet.getByRole("button", { name: "關閉", exact: true });
      await close.scrollIntoViewIfNeeded();
      await expectNoOverflow(page, width);
      await renderSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`more-dark-phone-${width}.png`) });
      await close.click();
      await expect(sheet).toBeHidden();
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);

      // The phone topbar is hidden in note detail; search is its search button
      // (the command palette), reached from the list, and choosing the result
      // returns to the note.
      await page.locator(".omt-back").click();
      await page.locator(".app-topbar .topbar-phone-search").click();
      await expect(page.locator(".palette-input-wrap input")).toBeFocused();
      await page.locator(".palette-input-wrap input").fill(note.title);
      await page.locator(".palette-item").filter({ has: page.getByText(note.title, { exact: true }) }).click();
      await expect(page.locator(".palette-modal")).toBeHidden();
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);

      // The same 日記 page as the desktop bar's.
      await mobileNav.getByRole("button", { name: "更多", exact: true }).click();
      await sheet.getByRole("button", { name: "日記", exact: true }).click();
      await expect(sheet).toBeHidden();
      await expect(page).toHaveURL((url) => url.searchParams.get("view") === "daily");
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await ready(page, `/?view=notes&node=${note.id}&lens=editor`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await renderSettled(page);
    await page.screenshot({ path: testInfo.outputPath("topbar-light-desktop-1280.png") });
  });
});

test("the last More action remains reachable on short phone screens and returns to the note", async ({ page }) => {
  await withNote(page, async (note) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 568 });
      await ready(page, `/?view=notes&node=${note.id}`);
      const trigger = page.locator(".mobile-bottom-nav").getByRole("button", { name: "更多", exact: true });
      await trigger.click();
      const sheet = page.getByRole("dialog", { name: "更多", exact: true });
      // The sheet's last action is 「管理功能」 (Settings › 功能, owner only;
      // hooks/shellNavigation getMoreNavigationGroups): Settings itself moved
      // behind the top-bar avatar (a6ee343b).
      const settingsAction = sheet.locator(".mobile-more-grid").getByRole("button", { name: "管理功能", exact: true });
      await expect(sheet.locator(".mobile-more-grid button").last()).toHaveText("管理功能");
      await settingsAction.scrollIntoViewIfNeeded();
      await expect(settingsAction).toBeInViewport();
      await expectInsidePanel(settingsAction, sheet);
      await settingsAction.click();
      await expect(sheet).toBeHidden();
      const settings = page.locator(".settings-modal");
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "關閉", exact: true }).click();
      await expect(settings).toBeHidden();
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);

      await trigger.click();
      await settingsAction.scrollIntoViewIfNeeded();
      const close = sheet.getByRole("button", { name: "關閉", exact: true });
      await close.scrollIntoViewIfNeeded();
      await expect(close).toBeInViewport();
      await close.click();
      await expect(sheet).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
      await expectNoOverflow(page, width);
    }
  });
});

test("note-list search opens on demand, still searches bodies, and closes without retaining a hidden query", async ({ page }) => {
  await withNote(page, async (note) => {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await ready(page, `/?view=notes&node=${note.id}&lens=editor`);
      if (width < 901) await page.locator(".omt-back").click();
      const toggle = page.locator(".sidebar-search-toggle");
      const search = sidebarSearch(page);
      await expect(toggle).toHaveAccessibleName("搜尋筆記");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(search).toBeHidden();
      await toggle.click();
      // The field is ui/SearchField since 2026-11-02: its label is the 「搜尋…」 hint.
      await expect(search).toHaveAccessibleName("搜尋筆記…");
      await expect(search).toBeFocused();
      await search.fill(note.bodyToken);
      const result = page.locator(".obsidian-search-row .obsidian-page-button").filter({ hasText: note.title });
      await expect(result, "the compact control retains full-text note search").toBeVisible();

      if (width === 1280) {
        await search.press("Tab");
        await page.keyboard.press("Control+f");
        await expect(search).toBeFocused();
        expect(await search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]))
          .toEqual([0, note.bodyToken.length]);
      }
      await search.press("Escape");
      await expect(search).toBeHidden();
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");

      if (width === 1280) await page.keyboard.press("Control+f");
      else await toggle.click();
      await expect(search).toBeFocused();
      await expect(search).toHaveValue("");
      await search.fill(note.title);
      await expect(result).toBeVisible();
      await toggle.click();
      await expect(search).toBeHidden();
      await toggle.click();
      await expect(search).toHaveValue("");
      await search.fill(note.title);
      await expect(result).toBeVisible();
      await result.click();
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
      await reloadColdStart(page);
      if (width < 901) await page.locator(".omt-back").click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(search).toBeHidden();
      await expectNoOverflow(page, width);
    }
  });
});

test("the desktop toolbar fits without a capture button and the hotkey opens focused quick capture", async ({ page }) => {
  await withNote(page, async (note) => {
    await ready(page, `/?view=notes&node=${note.id}`);
    const bar = page.locator(".app-topbar");
    for (const width of [1280, 1024, 901]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(bar.getByRole("button", { name: /^(捕捉|Capture)$/ })).toHaveCount(0);
      await expectToolbarFits(page, width);

      await openQuickCaptureByHotkey(page);
      const draft = page.locator(".quick-capture-textarea");
      await expect(draft).toBeFocused();
      // The one quiet line above the box names the account's usual place; it
      // never follows the open note (modules/capture/QuickCapture).
      const place = page.locator(".quick-capture-place");
      await expect(place).toHaveText(/^放進：/);
      await expect(place).not.toContainText(note.title);
      await draft.press("Escape");
      await expect(draft).toBeHidden();
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
    }

    await page.evaluate(() => localStorage.setItem("onden.locale", "en"));
    await reloadColdStart(page);
    // 1280 is the first full-row width, 1279 the widest compact one.
    for (const width of [1280, 1279, 1151, 901]) {
      await page.setViewportSize({ width, height: 900 });
      await expectToolbarFits(page, width);
    }
  });
});

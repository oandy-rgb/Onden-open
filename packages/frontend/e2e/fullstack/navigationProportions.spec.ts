import { test, expect, type Locator, type Page } from "@playwright/test";
import { ready, reloadColdStart, renderSettled, openNoteHistory, openNavDestination, openDisplayMenu, switchNoteView, BASE, sidebarSearch, closeSideBySide, scrollToSidebarRow, H } from "./helpers";

const WRITE = H;
const BODY = [
  "# Reading layout fixture",
  "這段筆記用來確認中英文混排的閱讀欄寬。字體放大後，文字仍然需要自然換行，切換版面也不能改動原本保存的內容。".repeat(5),
  "Reading should remain comfortable when the navigation and supporting panels change. ".repeat(12),
].join("\n\n");

test.beforeEach(async ({ page }) => {
  const target = new URL(BASE);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
  expect(["5099", "5100"], "these fixtures belong to the isolated onden_test stack").toContain(target.port);
  // These proportions are measured with the right side closed.
  await closeSideBySide(page.request, page);
  await page.addInitScript(() => {
    // Set the starting preferences only once: reload must exercise what the
    // user selected, rather than silently resetting the width under test.
    if (sessionStorage.getItem("navigation-proportions-started")) return;
    sessionStorage.setItem("navigation-proportions-started", "1");
    localStorage.setItem("onden.locale", "en");
    localStorage.setItem("onden.welcomeDismissed", "1");
    localStorage.setItem("onden.focusMode", "0");
    localStorage.setItem("onden.inspectorOpen", "0");
    localStorage.setItem("onden.inspectorCollapsed", "0");
    localStorage.setItem("onden.noteWide", "0");
  });
});

async function withNote(
  page: Page,
  run: (note: { id: string; title: string; updated_at: string }) => Promise<void>,
  fixture: { title?: string; markdown?: string } = {},
) {
  const title = fixture.title ?? `Navigation proportions ${Date.now()}`;
  const response = await page.request.post("/api/nodes", { ...WRITE, data: { title, markdown: fixture.markdown ?? BODY } });
  expect(response.status()).toBe(201);
  const note = await response.json() as { id: string; title: string; updated_at: string };
  try {
    await run(note);
  } finally {
    const deleted = await page.request.delete(`/api/nodes/${note.id}`, WRITE);
    expect(deleted.ok(), "remove only this test's note through the normal API").toBe(true);
  }
}

/** Phones fold the editor toolbar into ⋯ (the quiet note header, a bottom
 *  sheet of tiles): open an item there; wider screens use the toolbar's own control. */
async function phoneMenuItem(page: Page, name: string) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** Writing mode left the phone's ⋯: it is a ⌘K command (the 🔍 on a phone). */
async function phoneWritingMode(page: Page) {
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(">Writing mode");
  await page.locator(".palette-item", { hasText: "Writing mode" }).first().click();
}

/** The note font on a desktop window with the default settings: it grows with
 *  the window, max(17px, min(28px, 0.9375vw)) (styles/theme-tokens.css
 *  --onden-note-font; changes/2026-10-29-note-scale-with-window): 17px up to
 *  1813px wide, 18px at 1920. */
const noteFontAt = (width: number) => Math.max(17, Math.min(28, width * 0.009375));
/** The default 「寬度」 (Standard) is 41.18em of the note font, i.e. 700px at
 *  17px (settings/appearance.ts NOTE_MEASURE_EM, 290ac7b6): a readable line may
 *  not be wider than that. */
const readableAt = (width: number) => 41.18 * noteFontAt(width);

async function expectNoPageOverflow(page: Page, width: number) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

test("desktop modes share one top navigation and note history opens over the editor", async ({ page }) => {
  await withNote(page, async (note) => {
    await ready(page, `/?view=notes&node=${note.id}`);
    const primary = page.locator(".app-topbar").getByRole("navigation", { name: "Primary", exact: true });
    await expect(primary).toBeVisible();
    await expect(page.locator(".app-topbar").getByRole("tab", { name: "History", exact: true })).toHaveCount(0);

    // The center's one tab list is the page's own view strip (內容｜白板｜…｜＋,
    // a full-width title bar since 2026-11-03: changes/2026-11-03-view-tab-strip,
    // decisions-ui 「分頁列＝頁面的標題列」). History is not one of its tabs.
    const center = page.locator(".notes-center-wrap");
    await expect(center.getByRole("tablist")).toHaveCount(1);
    await expect(center.getByRole("tablist")).toHaveAccessibleName(`Views of ${note.title}`);
    await expect(center.getByRole("tab", { name: "History", exact: true })).toHaveCount(0);
    await openNoteHistory(page);
    await page.locator(".note-history-link").click();
    await expect(page.locator(".nh")).toBeVisible();
    await expect(page).not.toHaveURL(/lens=timeline/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);

    for (const [label, view, surface] of [
      ["Tasks", "tasks", ".tasks-mode"],
      ["Reading", "rss", ".rss-reader"],
      ["Review", "review", ".review-panel"],
    ]) {
      const action = await openNavDestination(page, label);
      await expect(page).toHaveURL(new RegExp(`view=${view}`));
      await expect(action).toHaveAttribute("aria-current", "page");
      await expect(page.locator(surface)).toBeVisible();
    }
    await primary.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
    // Back on the note, its history is the header's 「Version history」 again
    // (c38ff179 moved it there from the inspector's recent list).
    await expect(page.locator(".note-history-link")).toBeVisible();
  });
});

test("reading width adapts to desktop panels and full width survives reload without editing the note", async ({ page }, testInfo) => {
  await withNote(page, async (note) => {
    await ready(page, `/?view=notes&node=${note.id}`);
    await switchNoteView(page, "preview");
    const preview = page.locator(".note-document .obsidian-preview");
    const paragraph = preview.locator("p").first();
    const sidebar = page.locator(".overview-workspace > .obsidian-sidebar");
    const info = page.locator(".notes-inspector-toggle");

    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(preview).toBeVisible();
      // Prose keeps its 1.7 line height at the note font of this window.
      await expect(paragraph).toHaveCSS("font-size", `${noteFontAt(width)}px`);
      await expect.poll(async () => paragraph.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(noteFontAt(width) * 1.7, 1);
      const text = (await paragraph.boundingBox())!;
      const rail = (await sidebar.boundingBox())!;
      expect(text.width, `readable prose at ${width}px`).toBeLessThanOrEqual(readableAt(width) + 0.5);
      expect(text.width).toBeGreaterThan(500);
      expect(text.x).toBeGreaterThan(rail.x + rail.width);
      await expectNoPageOverflow(page, width);

      await info.click();
      await expect(info).toHaveAttribute("aria-pressed", "true");
      const inspector = page.locator(".overview-activity");
      await expect(inspector).toBeVisible();
      const inside = (await paragraph.boundingBox())!;
      const pane = (await inspector.boundingBox())!;
      for (const action of await inspector.getByRole("button").filter({ visible: true }).all()) {
        const bounds = (await action.boundingBox())!;
        expect(bounds.x + bounds.width, "long note titles must not push inspector controls out of view").toBeLessThanOrEqual(pane.x + pane.width);
      }
      expect(inside.x + inside.width).toBeLessThanOrEqual(pane.x);
      expect(inside.width).toBeGreaterThan(350);
      await expectNoPageOverflow(page, width);
      await renderSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`navigation-${width}.png`) });
      await info.click();
      await expect(info).toHaveAttribute("aria-pressed", "false");
      await expect(inspector).toBeHidden();
    }

    const before = await paragraph.textContent();
    const narrowWidth = (await paragraph.boundingBox())!.width;
    // Full width is a row of ⋯ › 顯示…; opening the menu shows whether it is on (aria-checked).
    // A checked row also draws a ✓ (ui.css .ui-menu-item--checked::after) with empty
    // alternative text, so its name stays exactly 「Full width」 either way.
    const FULL_WIDTH = /^Full width$/;
    const wide = page.getByRole("menuitemradio", { name: FULL_WIDTH });
    await (await openDisplayMenu(page)).getByRole("menuitemradio", { name: FULL_WIDTH }).click();
    await openDisplayMenu(page);
    await expect(wide).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeGreaterThan(narrowWidth + 100);
    await expect(paragraph).toHaveText(before!);

    await reloadColdStart(page);
    await openDisplayMenu(page);
    await expect(wide).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await switchNoteView(page, "preview");
    await expect(paragraph).toHaveText(before!);
    await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeGreaterThan(narrowWidth + 100);
    const persisted = await page.request.get(`/api/nodes/${note.id}`);
    expect(persisted.ok()).toBe(true);
    expect((await persisted.json()).markdown, "display preferences do not rewrite saved Markdown").toBe(BODY);
    await (await openDisplayMenu(page)).getByRole("menuitemradio", { name: FULL_WIDTH }).click();
    const last = page.viewportSize()!.width;
    await expect(paragraph).toHaveCSS("font-size", `${noteFontAt(last)}px`);
    await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeLessThanOrEqual(readableAt(last) + 0.5);
  });
});

test("phone note, tags and back controls fit 390px and 320px without losing the note", async ({ page }, testInfo) => {
  await withNote(page, async (note) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await ready(page, `/?view=notes&node=${note.id}`);
      const mobile = page.locator(".overview-mobile-tabs");
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
      await expect(page.locator(".mobile-bottom-nav")).toBeVisible();
      await phoneMenuItem(page, "Preview");
      await expect(page.locator(".obsidian-preview p").first()).toBeVisible();
      await expectNoPageOverflow(page, width);

      // A phone's note bar is ‹ Back, the tab name, one Info button (⊟) and ⋯ —
      // no 「筆記｜資訊」 switch (test/notesMobileTabs.test.tsx). The note's tags
      // are in the one grey line under the title (NoteMetaLine, the region
      // 「About this note」, which replaced the 「Tags」 block), and it fits the
      // phone like the rest.
      await expect(page.getByRole("button", { name: "Info", exact: true }).filter({ visible: true })).toHaveCount(1);
      const tagsBlock = page.getByRole("region", { name: "About this note", exact: true });
      await expect(tagsBlock).toBeVisible();
      await expect(tagsBlock.locator(".title-tag-row .prop-tag--add")).toBeVisible();
      for (const block of [tagsBlock, tagsBlock.locator(".title-tag-row")]) {
        const box = (await block.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect((await tagsBlock.boundingBox())!.width).toBeGreaterThan(240);
      await expectNoPageOverflow(page, width);
      await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
      await renderSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`navigation-${width}.png`) });

      await mobile.getByRole("button", { name: "Back to notes list", exact: true }).click();
      await expect(page.locator(".sidebar-search-toggle")).toBeVisible();
      await expect(sidebarSearch(page)).toBeHidden();
      await expectNoPageOverflow(page, width);
    }
  });
});

test("note header keeps word count and actions readable from phone to wide desktop in both languages", async ({ page }, testInfo) => {
  await withNote(page, async (note) => {
    await ready(page, `/?view=notes&node=${note.id}`);
    for (const locale of ["en", "zh-TW"]) {
      await page.evaluate((value) => {
        localStorage.setItem("onden.locale", value);
        localStorage.setItem("onden.inspectorOpen", "1");
      }, locale);
      await reloadColdStart(page);
      for (const width of [1920, 1280, 901, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const noteDocument = page.locator(".note-document");
        const title = noteDocument.locator(".obsidian-title-input");
        await expect(title).toHaveValue(note.title);
        // A saved note shows no save text or button at all (quiet save state).
        await expect(noteDocument.locator(".obsidian-save-state, .obsidian-save-button")).toHaveCount(0);
        // The one grey line under the title: space, edited, tags (the word count is in the info panel).
        await expect(noteDocument.locator(".note-meta-line")).toBeVisible();

        await expect(noteDocument.locator(".tiptap-slash-hint")).toHaveCount(0);
        await expect(noteDocument.locator(".cm-content")).toContainText("Reading layout fixture");
        await renderSettled(page);

        const surface = (await noteDocument.boundingBox())!;
        const controls = await noteDocument.locator(
          ".obsidian-title-input, .obsidian-actions button, .note-meta-line button",
        ).evaluateAll((elements) => elements.map((element) => {
          const { x, y, width: w, height: h } = element.getBoundingClientRect();
          // Phones: Share / ⋯ sit in the note's top bar, outside the editor.
          const inBar = window.innerWidth <= 900 && !!element.closest(".obsidian-actions");
          return { label: element.getAttribute("aria-label") || element.textContent || element.className, x, y, w, h, inBar };
        }).filter(({ w, h }) => w > 0 && h > 0));
        for (const [index, control] of controls.entries()) {
          const [left, right] = control.inBar ? [0, width] : [surface.x, surface.x + surface.width + 1];
          expect(control.x, `${locale}/${width}: ${control.label} starts in the editor`).toBeGreaterThanOrEqual(left);
          expect(control.x + control.w, `${locale}/${width}: ${control.label} fits the editor`).toBeLessThanOrEqual(right);
          for (const other of controls.slice(index + 1)) {
            const overlapX = Math.min(control.x + control.w, other.x + other.w) - Math.max(control.x, other.x);
            const overlapY = Math.min(control.y + control.h, other.y + other.h) - Math.max(control.y, other.y);
            expect(overlapX > 1 && overlapY > 1, `${locale}/${width}: ${control.label} does not cover ${other.label}`).toBe(false);
          }
        }
        // Top row, title, grey line, then the text: in that order down the page.
        const meta = (await noteDocument.locator(".note-meta-line").boundingBox())!;
        const titleBox = (await title.boundingBox())!;
        const text = (await noteDocument.locator(".cm-content").boundingBox())!;
        expect(titleBox.y + titleBox.height - 1, `${locale}/${width}: the grey line is under the title`).toBeLessThanOrEqual(meta.y);
        expect(meta.y + meta.height - 1, `${locale}/${width}: the text is under the grey line`).toBeLessThanOrEqual(text.y);
        if (width <= 900) {
          // The bar's ⋯ leaves the bar's own buttons (back, lenses) uncovered.
          const barButtons = await page.locator(".overview-mobile-tabs button").evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect()).map(({ x, width: w }) => ({ x, w })));
          for (const action of controls.filter((control) => control.inBar)) {
            for (const bar of barButtons) {
              expect(Math.min(action.x + action.w, bar.x + bar.w) - Math.max(action.x, bar.x) > 1,
                `${locale}/${width}: ${action.label} leaves the top bar's buttons uncovered`).toBe(false);
            }
          }
        }
        const heading = (await title.boundingBox())!;
        const content = (await noteDocument.locator(".cm-content").boundingBox())!;
        expect(content.y - heading.y, "the note body is close enough to its heading to read as one document").toBeLessThanOrEqual(width > 900 ? 200 : 260);
        if (width > 900) {
          const infoToggle = (await page.locator(".notes-inspector-toggle").boundingBox())!;
          expect(infoToggle.x).toBeGreaterThanOrEqual(0);
          expect(infoToggle.x + infoToggle.width).toBeLessThanOrEqual(width);
        }
        await expectNoPageOverflow(page, width);
        await page.screenshot({ path: testInfo.outputPath(`editor-${locale}-${width}.png`) });
      }
    }
    const persisted = await page.request.get(`/api/nodes/${note.id}`);
    expect((await persisted.json()).markdown, "layout changes must not replace the saved draft").toBe(BODY);
  }, { title: "很長的測試筆記標題 A long note title stays editable without hiding Save or reading controls" });
});

// A touch screen (pointer: coarse): the note's buttons keep their drawn size
// and an invisible ::after grows their touch area to --onden-tap (bd59080f),
// so the phone tap target is measured on that area, not the drawn box.
test.describe("on a touch screen", () => {
test.use({ hasTouch: true });
test("empty notes show one writing hint and keep all actions reachable", async ({ page }, testInfo) => {
  await withNote(page, async (note) => {
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.evaluate(() => {
      localStorage.setItem("onden.locale", "zh-TW");
      localStorage.setItem("onden.inspectorOpen", "1");
      localStorage.setItem("onden.noteWide", "1");
      localStorage.setItem("theme", "dark");
    });
    await reloadColdStart(page);
    for (const width of [1920, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const noteDocument = page.locator(".note-document");
      // The empty-note hint is drawn beside the editable content since
      // 4b567369 (lib/editorEmptyHint: .cm-emptyHint, not CodeMirror's
      // .cm-placeholder inside the first line).
      await expect(noteDocument.locator(".cm-emptyHint")).toBeVisible();
      await expect(noteDocument.locator(".tiptap-slash-hint")).toHaveCount(0);
      // The note's actions: on a wide screen 編輯｜並排｜預覽 and ⋯ sit at the right
      // of the page's view strip (.center-lens-bar, since 2026-11-03); a phone has
      // no strip and keeps ⊟ and ⋯ in the note's own header, drawn in its top bar.
      const actions = page.locator(".center-lens-bar button, .note-document .obsidian-actions button").filter({ visible: true });
      expect(await actions.count(), "the note's actions are on screen").toBeGreaterThan(0);
      for (const control of await actions.all()) {
        await expect(control).toBeVisible();
        const bounds = (await control.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        if (width === 320) {
          const touch = await control.evaluate((element) => parseFloat(getComputedStyle(element, "::after").height));
          expect(touch, "phone actions keep a usable tap target").toBeGreaterThanOrEqual(44);
        }
      }
      // Wide: ⋯ › 顯示…; phone: the preview lives in the ⋯ sheet.
      const display = page.getByRole("button", { name: /^(More actions|更多動作)$/ }).filter({ visible: true });
      await expect(display).toHaveCount(1);
      const options = width > 900 ? await openDisplayMenu(page) : (await display.click(), page.locator(".note-actions-sheet"));
      await expect(options).toBeVisible();
      const popup = (await options.boundingBox())!;
      expect(popup.x).toBeGreaterThanOrEqual(0);
      expect(popup.x + popup.width).toBeLessThanOrEqual(width);
      if (width <= 900) await expect(options.getByRole("menuitem", { name: "預覽", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(options).toBeHidden();
      await expect(display).toBeFocused();
      await expectNoPageOverflow(page, width);
      await renderSettled(page);
      await page.screenshot({ path: testInfo.outputPath(`empty-note-zh-TW-${width}.png`) });
    }
  }, { title: "2026-09-29", markdown: "" });
});
});

test("writing mode stays escapable on desktop and phone and preserves saved edits", async ({ page }) => {
  await withNote(page, async (note) => {
    await ready(page, `/?view=notes&node=${note.id}`);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const toggle = page.locator(".editor-zen-toggle");
      if (width > 900) {
        await (await openDisplayMenu(page)).getByRole("menuitem", { name: "Writing mode", exact: true }).click();
      } else await phoneWritingMode(page);
      await expect(page.locator("body")).toHaveClass(/onden-zen/);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toBeVisible();
      const body = page.locator(".md-editor-cm .cm-content");
      await expect(body).toContainText("Reading layout fixture");
      if (width === 1280) await page.keyboard.press("Escape");
      else await toggle.click();
      await expect(page.locator("body")).not.toHaveClass(/onden-zen/);
      await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
      await expectNoPageOverflow(page, width);
    }
    const marker = `Saved after writing mode ${Date.now()}`;
    const content = page.locator(".md-editor-cm .cm-content");
    await content.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(`\n\n${marker}`);
    await page.keyboard.press("Control+s");
    await expect.poll(async () => (await (await page.request.get(`/api/nodes/${note.id}`)).json()).markdown).toContain(marker);
    await reloadColdStart(page);
    await expect(content).toContainText(marker);
    await expect(page.locator("body")).not.toHaveClass(/onden-zen/);
    await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
  });
});

test("note information has one toggle and history is available on desktop and phone", async ({ page }, testInfo) => {
  await withNote(page, async (note) => {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await ready(page, `/?view=notes&node=${note.id}`);
      if (width > 900) {
        // The info panel is one row of tabs, 功能｜標籤｜關係｜AI (2026-10-31:
        // changes/2026-10-31-info-panel-functions, lib/infoPanel.ts), in place of
        // the old 「Properties」 sidebar; a plain note has no switch on (NoteSwitches
        // lists only the ones that are on), and tags are still added only in the
        // row under the title.
        await page.locator(".notes-inspector-toggle").click();
        const info = page.locator(".overview-activity");
        await expect(info).toBeVisible();
        const infoTabs = info.getByRole("tablist", { name: "Info", exact: true });
        await expect(infoTabs).toHaveCount(1);
        for (const name of ["Functions", "Tags", "Relations"]) await expect(infoTabs.getByRole("tab", { name, exact: true })).toBeVisible();
        await expect(info.getByRole("switch")).toHaveCount(0);
        await infoTabs.getByRole("tab", { name: "Tags", exact: true }).click();
        await expect(info.getByRole("tabpanel", { name: "Tags", exact: true })).toBeVisible();
        await expect(info.locator(".title-tag-row, .prop-tag--add")).toHaveCount(0);
        await expect(page.locator(".title-tag-row .prop-tag--add")).toHaveCount(1);
      } else {
        // A phone's note bar has one Info button (⊟) and no 「筆記｜資訊」 switch
        // (test/notesMobileTabs.test.tsx); the same tag row sits under the title.
        await expect(page.getByRole("button", { name: "Info", exact: true }).filter({ visible: true })).toHaveCount(1);
        await expect(page.locator(".title-tag-row .prop-tag--add")).toBeVisible();
      }
      // Version history is a header action under the title.
      const entry = page.locator(".note-history-link");
      await expect(entry).toBeVisible();
      await entry.click();
      const modal = page.locator(".nh");
      await expect(modal).toBeVisible();
      const dialog = (await modal.boundingBox())!;
      expect(dialog.x).toBeGreaterThanOrEqual(0);
      expect(dialog.x + dialog.width).toBeLessThanOrEqual(width);
      await expect(page).not.toHaveURL(/lens=timeline/);
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);
      await expect(entry).toBeFocused();
      if (width <= 900) {
        const tabs = page.locator(".overview-mobile-tabs");
        const bounds = (await tabs.boundingBox())!;
        expect(bounds.y, "closing history keeps mobile navigation on screen").toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
      }
      await expectNoPageOverflow(page, width);
      await page.screenshot({ path: testInfo.outputPath(`inspector-history-${width}.png`) });
    }
  });
});


test("desktop Info recovers hidden sidebars and a saved collapsed pane", async ({ page }) => {
  await withNote(page, async (note) => {
    await ready(page, `/?view=notes&node=${note.id}`);
    await openNoteHistory(page);
    // Focus mode (both sidebars away) is Ctrl+Alt+F: Ctrl+\ became 「並排」, which
    // opens a right side and saves it to the account (decisions-ui 「視角＋並排」 快捷鍵).
    await page.keyboard.press("Control+Alt+f");
    await expect(page.locator(".overview-activity")).toBeHidden();
    // The panel comes back with its content: the open tab of 功能｜標籤｜關係｜AI
    // (the Tags tab's cards are no longer what it opens on: lib/infoPanel.ts
    // initialInfoTab, changes/2026-10-31-info-panel-functions).
    const panelBody = page.locator(".overview-activity").getByRole("tabpanel");
    await page.locator(".notes-inspector-toggle").click();
    await expect(panelBody).toBeVisible();
    await expect(page.locator(".obsidian-sidebar")).toBeVisible();
    await page.evaluate(() => localStorage.setItem("onden.inspectorCollapsed", "1"));
    await reloadColdStart(page);
    await expect(page.locator(".overview-activity")).toHaveCount(0);
    await page.locator(".notes-inspector-toggle").click();
    await expect(panelBody).toBeVisible();
  });
});


test("collection and canvas views remain reachable without duplicate phone tabs", async ({ page }) => {
  // Two cold loads and a board at each width.
  test.setTimeout(120_000);
  await withNote(page, async (note) => {
    const response = await page.request.post("/api/nodes", { ...WRITE, data: { title: "Child for note views", markdown: "child", parent_id: note.id } });
    expect(response.status()).toBe(201);
    const child = await response.json() as { id: string };
    try {
      // Since 2026-11-03 (changes/2026-11-03-view-tab-strip, decisions-ui
      // 「分頁列＝頁面的標題列」) a wide screen's view tabs are the page's title strip
      // with 「＋」, which adds the canvas. A phone's tabs are back in ONE row above the
      // title since 2026-11-07 (changes/2026-11-07-phone-tabs-above-title, #1331): the
      // same ViewTabs in the page (.phone-view-tabs), none in the note's top bar.
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await ready(page, `/?view=notes&node=${note.id}`);
        await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
        await expect(page.locator(".note-history-link")).toBeVisible();
        // The children's collection is the Content page's Sub-notes section
        // now (#486 removed the Table lens): no Table tab, the child is listed.
        await expect(page.getByRole("tab", { name: "Table", exact: true })).toHaveCount(0);
        await expect(page.getByRole("region", { name: /Sub-notes/ }).getByRole("button", { name: "Child for note views", exact: true })).toBeVisible();
        let views: Locator;
        if (width > 900) {
          views = page.locator(".center-lens-bar");
          await views.getByRole("button", { name: "Add a view", exact: true }).click();
          await page.getByRole("dialog", { name: "Add a view" }).getByRole("button", { name: "Canvas", exact: true }).click();
        } else {
          await expect(page.locator(".center-lens-bar")).toBeHidden();
          const bar = page.locator(".overview-mobile-tabs");
          // No second row of tabs on the phone: the top bar holds none (‹ and the note's place),
          // and the page has exactly one tab row, above the title.
          await expect(bar.getByRole("tab")).toHaveCount(0);
          await expect(bar.getByRole("button", { name: /^(Content|Canvas)$/ })).toHaveCount(0);
          await expect(page.getByRole("tablist", { name: `Views of ${note.title}` })).toHaveCount(1);
          views = page.locator(".phone-view-tabs");
          await expect(views.getByRole("tab", { name: "Content", exact: true })).toHaveAttribute("aria-selected", "true");
          // The canvas added at 1280px above is the row's second tab.
          await views.getByRole("tab", { name: "Canvas", exact: true }).click();
        }
        await expect(page).toHaveURL(/lens=canvas/);
        // The board opens on the note and its sub-note as cards (it is no longer an empty state).
        await expect(page.locator(".react-flow")).toBeVisible();
        if (width <= 900) {
          // A phone's board is full screen: its title ⌄ at the top opens the same sheet (#1264).
          await page.getByRole("button", { name: note.title, exact: true }).click();
          views = page.getByRole("dialog");
        }
        await views.getByRole("tab", { name: "Content", exact: true }).click();
        await expect(page.locator(".obsidian-title-input")).toHaveValue(note.title);
        await expectNoPageOverflow(page, width);
      }
    } finally {
      expect((await page.request.delete(`/api/nodes/${child.id}`, WRITE)).ok()).toBe(true);
    }
  });
});

test("a long note title never widens the note list or pushes titles out of view", async ({ page }) => {
  // Two cold loads, and on a phone a windowed list walked a screen at a time to reach the row.
  test.setTimeout(120_000);
  // A note with children renders as a group header; its long title used to
  // size the list's grid column, so the list panned sideways when a row was
  // clicked and every title lost its left part.
  await withNote(page, async (note) => {
    const child = await page.request.post("/api/nodes", { ...WRITE, data: { title: `Child of a long title ${Date.now()}`, markdown: "child", parent_id: note.id } });
    expect(child.status()).toBe(201);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await ready(page, `/?view=notes&node=${note.id}`);
      // The cold-start membership check covers the workspace for a moment (rows unmount under it).
      await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
      if (width <= 900) await page.locator(".omt-back").click();
      const list = page.locator(".obsidian-page-list").filter({ visible: true }).first();
      const row = list.locator(`[data-sb-id="${note.id}"] .obsidian-group-title`).first();
      // On a phone a row opens the note; there the list is measured as shown. Coming back to the
      // list no longer scrolls to the open note by itself (changes/2026-11-07-list-no-first-note-highlight,
      // #1342), and a busy workspace's list is windowed: bring the row into the page first.
      if (width > 900) {
        await row.click();
        // Rows other writers add above it (the shared e2e workspace) can push a windowed list's row out of
        // its window after the click: bring it back to measure it.
        if (!(await row.isVisible())) await scrollToSidebarRow(page, note.id);
      } else await scrollToSidebarRow(page, note.id);
      await expect(row, "the row is in the list").toBeVisible();
      const geometry = await list.evaluate((element) => ({
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollLeft: element.scrollLeft,
      }));
      expect(geometry.scrollWidth, `list content fits the rail at ${width}px`).toBeLessThanOrEqual(geometry.clientWidth + 1);
      expect(geometry.scrollLeft).toBe(0);
      const listBox = (await list.boundingBox())!;
      const titleBox = (await row.locator(".sb-item-title").boundingBox())!;
      expect(titleBox.x, "title starts inside the list").toBeGreaterThanOrEqual(listBox.x);
      expect(titleBox.x + titleBox.width, "title is clipped inside the list").toBeLessThanOrEqual(listBox.x + listBox.width + 1);
    }
  }, { title: `A very long group title that is much wider than the sidebar rail ${Date.now()} with even more words` });
});

import { test, expect } from "@playwright/test";
import { ready, seedNodes } from "./helpers";

// VISUAL CHECK [mobile-editor-toolbar] — the above-keyboard formatting toolbar
// (pillar 2 of the two-axis mobile nav) renders pinned to the bottom of the
// editor viewport when the note body is focused on a phone-width screen, and its
// buttons apply markdown via the existing CM helpers.
//
// The keyboard-FOLLOW behaviour (visualViewport-driven kbInset) can only be
// verified on a real device — headless has no on-screen keyboard, so kbInset is
// 0 and the bar sits at bottom:0. This spec proves it renders + is interactive.

test.use({ viewport: { width: 390, height: 844 } });

test("mobile editor toolbar renders on focus and applies formatting", async ({ page }) => {
  await ready(page);
  const token = `mtb-${Date.now()}`;
  const [nodeId] = await seedNodes(page, 1, { token, title: () => `${token} note` });

  await ready(page, `/?view=notes&node=${nodeId}`);

  // Focus the note body (CodeMirror content). On mobile the editor shows in the
  // "edit" drill-in; the toolbar is gated on editor focus.
  const content = page.locator(".md-editor-cm .cm-content");
  await content.waitFor({ state: "visible", timeout: 30_000 });
  await content.click();

  const toolbar = page.locator(".md-mobile-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 10_000 });
  // The high-value buttons are present.
  await expect(page.locator(".md-mobile-tool[aria-label='Heading 1']")).toBeVisible();
  await expect(page.locator(".md-mobile-tool[aria-label='Bold']")).toBeVisible();
  await expect(page.locator(".md-mobile-tool[aria-label='Checklist']")).toBeVisible();

  // The bar starts with the paragraph tools (since 2026-11-01 each is its own button, no ¶ menu):
  // 「Add tag」 and 「Copy block link」 in words, then AI (lib/toolbarLayout BAR_TOOLS).
  const tools = page.locator(".md-mobile-toolbar-scroll > .md-mobile-tool");
  await expect(tools.nth(0)).toHaveAttribute("aria-label", "Add tag");
  await expect(tools.nth(0)).toHaveText("Add tag");
  await expect(tools.nth(1)).toHaveAttribute("aria-label", "Copy block link");
  await expect(page.locator(".md-mobile-tool[aria-label='This paragraph']")).toHaveCount(0);

  await page.screenshot({ path: "/tmp/pw-output/shots/mobile-editor-toolbar.png" });

  // 「Link to a note」 types `[[` and opens the note-link popup; Escape closes it, the text stays.
  await page.locator(".md-mobile-tool[aria-label='Link to a note']").click();
  await expect(content).toContainText("[[");
  await expect(page.locator(".slash-menu-popup .slash-menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // 「Add tag」 opens the paragraph's tag picker above the bar; the bar stays up under it.
  await page.locator(".md-mobile-tool[aria-label='Add tag']").click();
  await expect(page.getByRole("dialog", { name: "Tag this paragraph" })).toBeVisible();
  await expect(toolbar).toBeVisible();
  await page.keyboard.press("Escape");

  // Tapping Bullet list applies a "- " block prefix to the current line via the
  // shared applyBlockPrefix helper (pointerdown keeps editor focus).
  await page.locator(".md-mobile-tool[aria-label='Bullet list']").click();
  await expect(content).toContainText("-");
  // The bar stays up (focus preserved through the tap).
  await expect(toolbar).toBeVisible();
});

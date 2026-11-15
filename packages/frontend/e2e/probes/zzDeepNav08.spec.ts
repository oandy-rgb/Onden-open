// Feature-audit deepening (2026-10-08): NAV-08 — Escape priority while in
// writing mode (palette open, More-actions menu open, IME composing).
import { test, type Page } from "@playwright/test";
import { openDisplayMenu, ready, H } from "../fullstack/helpers";


test("NAV-08: Escape priority in writing mode", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const note = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Zen ${stamp}`, markdown: "zen body" } })).json()).id as string;
  const zen = () => page.evaluate(() => document.body.classList.contains("onden-zen"));
  const enter = async (p: Page) => {
    if (await zen()) return;
    const display = await openDisplayMenu(p);
    await display.getByRole("menuitem", { name: /^(Writing mode|寫作模式)$/ }).click();
    await p.waitForTimeout(500);
  };
  await ready(page, `/?view=notes&node=${note}&lens=editor`);
  await page.waitForTimeout(1000);
  await enter(page);
  out.entered = await zen();
  // Palette open → Escape.
  await page.keyboard.press("Control+k"); await page.waitForTimeout(300);
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  out.paletteEsc = { paletteClosed: !(await page.locator(".palette-input-wrap input").isVisible().catch(() => false)), zenKept: await zen() };
  await enter(page);
  // More actions menu → Escape.
  await page.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  const menuOpen = await page.getByRole("menu", { name: "More actions" }).isVisible().catch(() => false);
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  out.menuEsc = { menuWasOpen: menuOpen, menuClosed: !(await page.getByRole("menu", { name: "More actions" }).isVisible().catch(() => false)), zenKept: await zen() };
  await enter(page);
  // IME composing Escape (cancels a candidate).
  await page.locator(".cm-content").first().click();
  await page.locator(".cm-content").first().evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(300);
  out.imeEsc = { zenKept: await zen() };
  await enter(page);
  // Plain Escape exits.
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  out.plainEsc = { zenExited: !(await zen()) };

  console.log("NAV08 " + JSON.stringify(out, null, 2));
});

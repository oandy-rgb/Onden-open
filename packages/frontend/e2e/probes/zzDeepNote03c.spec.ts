// NOTE-03 follow-up (2026-10-08): which offline create paths open an editable
// note — quick capture vs. command palette create-on-miss vs. Today.
import { test, type Page } from "@playwright/test";
import { ready, openQuickCaptureByHotkey } from "../fullstack/helpers";

test("NOTE-03c: offline create paths open an editor?", async ({ page, context }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const gate = page.getByText("Checking your workspace", { exact: false });
  const fresh = async () => { await ready(page, "/?view=notes"); await page.waitForTimeout(4000); for (let i = 0; i < 40 && await gate.isVisible().catch(() => false); i++) await page.waitForTimeout(500); await context.setOffline(true); await page.waitForTimeout(800); };
  const state = async (p: Page) => ({ url: /node=/.test(p.url()), editor: await p.locator(".cm-content").count(), title: await p.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null) });
  await fresh();
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(`PalOff ${stamp}`);
  await page.waitForTimeout(600);
  out.paletteRows = (await page.getByRole("option").allInnerTexts().catch(() => [])).slice(0, 4);
  await page.getByRole("option", { name: new RegExp(`Create note: PalOff ${stamp}`) }).first().click().catch((e) => { out.paletteErr = String(e).slice(0, 80); });
  await page.waitForTimeout(1500);
  out.palette = await state(page);
  await context.setOffline(false); await page.waitForTimeout(3000);
  await fresh();
  await openQuickCaptureByHotkey(page);
  await page.locator(".quick-capture-textarea").fill(`CapOff ${stamp}\nbody`);
  await page.locator(".quick-capture-textarea").press("Control+Enter");
  await page.waitForTimeout(2000);
  out.capture = await state(page);
  await context.setOffline(false); await page.waitForTimeout(8000);
  out.captureAfterOnline = await state(page);
  console.log("NOTE03C " + JSON.stringify(out, null, 2));
});

// NAV-05 follow-up (2026-10-08): does Ctrl+N do anything in the notes editor,
// does "?" (with and without Shift) open the cheatsheet, and what does
// Ctrl+\ change on screen?
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";

test("NAV-05b: Ctrl+N, ?, Ctrl+\\ effects", async ({ page }) => {
  test.setTimeout(120_000);
  const out: Record<string, unknown> = {};
  await ready(page, "/?view=notes");
  await page.waitForTimeout(1500);
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await blur();
  await page.keyboard.press("Control+n"); await page.waitForTimeout(800);
  out.ctrlN = { createBox: await page.locator(".create-node-box").count(), dialogs: await page.locator("[role=dialog]").filter({ visible: true }).count(), active: await page.evaluate(() => `${document.activeElement?.tagName}:${(document.activeElement as HTMLInputElement)?.placeholder ?? ""}`) };
  await page.keyboard.press("Escape"); await blur();
  const ev1 = page.evaluate(() => new Promise<string>((res) => window.addEventListener("keydown", (e) => res(`key=${e.key} shift=${e.shiftKey} code=${e.code}`), { once: true })));
  await page.keyboard.press("?"); await page.waitForTimeout(500);
  out.questionEvent = await ev1;
  out.questionKey = await page.locator(".shortcuts-modal").isVisible().catch(() => false);
  await page.keyboard.press("Escape"); await blur();
  const evP = page.evaluate(() => new Promise<string>((res) => window.addEventListener("keydown", (e) => res(`key=${e.key} shift=${e.shiftKey} code=${e.code}`), { once: true })));
  await page.keyboard.press("Shift+Slash");
  out.shiftSlashEvent = await evP;
  await page.waitForTimeout(500);
  out.shiftSlashOpens = await page.locator(".shortcuts-modal").isVisible().catch(() => false);
  await page.keyboard.press("Escape"); await blur();
  const vis = () => page.evaluate(() => ({ sidebar: !!document.querySelector(".obsidian-sidebar, .overview-sidebar") && getComputedStyle(document.querySelector(".obsidian-sidebar, .overview-sidebar") as Element).display !== "none", bodyClass: document.body.className, rootClass: (document.querySelector(".builder-app, .app-shell, #root > div") as HTMLElement | null)?.className?.slice(0, 120) ?? null }));
  const before = await vis();
  await page.keyboard.press("Control+Backslash"); await page.waitForTimeout(600);
  out.ctrlBackslash = { before, after: await vis() };
  console.log("NAV05B " + JSON.stringify(out, null, 2));
});

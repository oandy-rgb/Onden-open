// Feature-audit deepening (2026-10-08): REV-03 follow-up — what "Review cards
// under this note" shows for a note whose subtree has no cards, and whether
// the palette offers it at all there.
import { test } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


test("REV-03b: empty deck UI", async ({ page }) => {
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const e = await (await page.request.post("/api/nodes", { ...H, data: { title: `R03b Empty ${stamp}`, markdown: "no cards" } })).json();
  await page.request.post("/api/nodes", { ...H, data: { title: `R03b child ${stamp}`, markdown: "plain", parent_id: e.id } });
  await ready(page, `/?view=notes&node=${e.id}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(">Review cards");
  await page.waitForTimeout(800);
  out.paletteItems = (await page.locator(".palette-item").allInnerTexts()).map((s) => s.replace(/\s+/g, " ")).slice(0, 5);
  const item = page.locator(".palette-item", { hasText: "Review cards under this note" }).first();
  if (await item.count()) {
    await item.click();
    await page.locator(".review-panel").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    out.panel = (await page.locator(".review-panel").innerText()).replace(/\s+/g, " ").slice(0, 300);
  }
  console.log("REV03B " + JSON.stringify(out, null, 2));
});

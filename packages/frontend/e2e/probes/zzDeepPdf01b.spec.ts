// Feature-audit deepening (2026-10-08): PDF-01 follow-up — a 30 MB PDF through
// the sidebar "+" → PDF chooser: nginx answers 413 (client_max_body_size 20m)
// although the backend allows 200 MB. What does the user see?
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";
import { readFileSync } from "node:fs";

const FX = "/var/home/oandy/桌面/git/note/Onden/.acceptance/feature-loop-2026-10-07/tick7/fixture";

test("PDF-01b: 30 MB PDF upload through the UI", async ({ page }) => {
  test.setTimeout(180_000);
  const out: Record<string, unknown> = {};
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  const before = page.url();
  await page.locator('button[aria-label="Create new node"]').click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(".sidebar-sort-menu-item", { hasText: /PDF/ }).first().click()]);
  const t0 = Date.now();
  await chooser.setFiles({ name: `bigscan-${Date.now()}.pdf`, mimeType: "application/pdf", buffer: readFileSync(`${FX}/bigscan.pdf`) });
  await page.waitForTimeout(8000);
  out.ms = Date.now() - t0;
  out.toasts = (await page.locator(".toast").allInnerTexts().catch(() => [])).map((s) => s.replace(/\s+/g, " ").slice(0, 200));
  out.panels = (await page.locator(".fwr-card").allInnerTexts().catch(() => [])).map((s) => s.replace(/\s+/g, " ").slice(0, 200));
  out.urlChanged = page.url() !== before;
  console.log("PDF01B " + JSON.stringify(out, null, 2));
});

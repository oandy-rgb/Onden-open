import { test, expect, type Page } from "@playwright/test";
import { ready, openQuickCapture, pollBootstrap } from "./helpers";

// Screenshots for a design pass on QUICK CAPTURE — the retention core
// (note-use-cases: highest-frequency, must feel as low-friction as pen + paper).
const SHOTS = "/tmp/pw-output/shots";

async function openCapture(page: Page) {
  await openQuickCapture(page); // polls until the sheet is actually open
  await page.locator(".quick-capture-textarea").waitFor({ timeout: 8000 });
}

test("design: quick capture", async ({ page }) => {
  await ready(page, "/?view=notes");

  // 1) Empty capture sheet (the first thing you see when you hit ⌘⇧N).
  await openCapture(page);
  await page.screenshot({ path: `${SHOTS}/dc-capture-empty.png`, fullPage: false });

  // 2) Mid-capture with a real fleeting thought.
  const textarea = page.locator(".quick-capture-textarea");
  await textarea.fill("Call the dentist tomorrow\n- and book the Q3 review with Apollo team\n- idea: tag-driven RAG answers");
  await expect(textarea).toHaveValue(/tag-driven RAG answers/); // fill committed
  await page.screenshot({ path: `${SHOTS}/dc-capture-filled.png`, fullPage: false });
});

// Frictionless capture must be KEYBOARD-ONLY: ⌘/Ctrl+Enter commits, Esc cancels.
test("Ctrl+Enter commits the capture without the mouse", async ({ page }) => {
  const stamp = Date.now();
  await ready(page, "/?view=notes");
  await openCapture(page);
  await page.locator(".quick-capture-textarea").fill(`keyboard capture ${stamp}`);
  await page.keyboard.press("Control+Enter");
  // Committed: the box says where it went and empties for the next thought (since 2026-10-29).
  await expect(page.locator(".quick-capture-saved")).toBeVisible();
  await expect(page.locator(".quick-capture-textarea")).toHaveValue("");
  // Poll the server until the capture lands (the save round-trip is async).
  await pollBootstrap(page, (b) => b.nodes.find((n: { title: string }) => n.title.startsWith(`keyboard capture ${stamp}`)));
});

test("Escape cancels the capture (no save)", async ({ page }) => {
  await ready(page, "/?view=notes");
  await openCapture(page);
  await page.locator(".quick-capture-textarea").fill("draft I will discard");
  await page.keyboard.press("Escape");
  await expect(page.locator(".quick-capture-overlay")).toHaveCount(0);
});

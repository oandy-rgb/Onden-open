// P0-2 nav-position regression: the editor restores the caret (scrolled into
// view) on reload AND when switching back to a note — losing your place was
// the trust-killer the per-node-lens research flagged.
import { test, expect } from "@playwright/test";
import { H } from "./helpers";


const LONG_BODY = "# Long note\n\n" +
  Array.from({ length: 200 }, (_, i) => `line-${i + 1} lorem ipsum dolor sit amet`).join("\n\n");

test("caret + scroll survive switching away and back, and a reload", async ({ page }) => {
  const a = await (await page.request.post("/api/nodes", { ...H, data: { title: "NavPos long", markdown: LONG_BODY } })).json();
  const b = await (await page.request.post("/api/nodes", { ...H, data: { title: "NavPos other", markdown: "other note" } })).json();

  // Open the long note and move the caret to the END (CodeMirror virtualizes
  // long docs, so off-screen lines aren't in the DOM to click — Ctrl+End is
  // the deterministic way to park the caret deep in the document).
  await page.goto(`/?view=notes&node=${a.id}`, { waitUntil: "load" });
  const scroller = page.locator(".cm-scroller");
  await scroller.waitFor({ state: "visible" });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await expect(page.getByText("line-200", { exact: false }).first()).toBeInViewport();
  await expect.poll(async () =>
    page.evaluate((id) => window.sessionStorage.getItem(`onden.cursor.${id}`), a.id),
  ).not.toBeNull();

  // Switch to another note (top scroll), then back — the caret line must be
  // back in view, not the top of the document.
  await page.goto(`/?view=notes&node=${b.id}`, { waitUntil: "load" });
  await expect(page.locator(".cm-content")).toContainText("other note");
  await page.goto(`/?view=notes&node=${a.id}`, { waitUntil: "load" });
  // line-200 visible == the view scrolled to the caret; line-1 NOT visible ==
  // we did not just land at the top (the old behavior).
  await expect(page.getByText("line-200", { exact: false }).first()).toBeInViewport();
  await expect(page.getByText("line-1 lorem", { exact: false }).first()).not.toBeInViewport();

  // Reload keeps the place too (sessionStorage survives a refresh).
  await page.reload({ waitUntil: "load" });
  await expect(page.getByText("line-200", { exact: false }).first()).toBeInViewport();
});

import { test, expect } from "@playwright/test";
import { ready, openQuickCapture, H } from "./helpers";

// Cross-browser + responsive UI (#10). Runs on chromium / firefox / webkit and
// on mobile viewports (Pixel 5 / iPhone 13 via the config's projects). The
// point is the INTERACTIVE SURFACE renders + works on each engine AND at phone
// width — where the app deliberately swaps to a different shell (a bottom nav
// instead of the desktop lens strip, and List/Edit/Info tabs instead of a
// side-by-side editor). So the assertions are viewport-aware, not desktop-only.
const isMobile = () => test.info().project.name.startsWith("mobile");

test.describe("cross-browser + responsive UI", () => {
  // Desktop shows the top navigation; phone width swaps to the bottom nav. Either
  // way, the primary navigation chrome must render.
  test("app shell navigation renders for this viewport", async ({ page }) => {
    await ready(page);
    // The desktop navigation stays in the DOM but is display:none at phone
    // width, so assert the nav that's actually shown for this viewport.
    const nav = isMobile() ? ".mobile-bottom-nav" : ".app-primary-nav";
    await expect(page.locator(nav).first()).toBeVisible();
  });

  // The single most common responsive defect: content wider than the viewport.
  test("no horizontal overflow at this viewport", async ({ page }) => {
    await ready(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "page overflows horizontally (responsive break)").toBeLessThanOrEqual(2);
  });

  // Both shells reach the same task destination.
  test("primary navigation responds", async ({ page }) => {
    await ready(page);
    if (isMobile()) {
      await page.locator('.mobile-bottom-nav .mobile-nav-btn:has-text("Tasks")').click();
      await expect(page).toHaveURL(/view=tasks/);
    } else {
      await page.locator('.app-primary-nav').getByRole("button", { name: "Tasks", exact: true }).click();
      await expect(page).toHaveURL(/view=tasks/);
    }
  });

  // Quick capture is the mobile-first primary action — the sheet must open,
  // accept input, and persist a node on every engine + viewport.
  test("quick capture opens, accepts input, and persists", async ({ page }) => {
    await ready(page);
    const body = `xb capture ${test.info().project.name} ${Date.now()}`;
    await openQuickCapture(page);
    const ta = page.locator(".quick-capture-textarea");
    await expect(ta).toBeVisible();
    await ta.fill(body);
    const save = page.locator(".quick-capture-save");
    await save.scrollIntoViewIfNeeded().catch(() => {});
    await save.click();
    await expect.poll(async () => {
      const r = await page.request.get("/api/bootstrap");
      const b = r.ok() ? await r.json() : {};
      return (b.nodes ?? []).some((x: { title?: string }) => x.title === body);
    }, { timeout: 12_000 }).toBeTruthy();
  });

  // CodeMirror is a notorious cross-engine risk (contenteditable / IME / key
  // handling differ across Gecko/WebKit/Blink). On mobile the editor lives
  // under the "Edit" tab, so switch to it first.
  test("editor mounts and accepts input across engines", async ({ page }) => {
    const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `xb edit ${Date.now()}`, markdown: "seed" } })).json();
    await ready(page, `/?view=notes&node=${node.id}`);
    if (isMobile()) {
      await page.locator('.overview-mobile-tabs button:has-text("Edit")').click().catch(() => {});
    }
    const editor = page.locator(".cm-content").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("End");
    const stamp = `k-${Date.now()}`;
    await page.keyboard.type(stamp);
    await expect(editor).toContainText(stamp);
  });
});

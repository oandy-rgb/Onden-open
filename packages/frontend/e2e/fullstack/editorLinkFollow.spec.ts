// Following a link from the editor, without switching to Preview
// (src/lib/editorLinkFollow.ts). Gestures under test:
//   desktop  plain click places the caret; Ctrl/Cmd+click follows
//   phone    a tap while the editor is NOT focused follows; while it is
//            focused a tap places the caret and the "Open ↗" chip follows
// Runs on chromium (desktop) and, via CROSS_ENGINE in playwright.config.ts,
// the mobile projects; each test skips on the other kind of project.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";


async function seed(page: Page) {
  const stamp = Date.now();
  const targetTitle = `Link target ${stamp}`;
  const targetMarker = `target-body-${stamp}`;
  const target = await (await page.request.post("/api/nodes", {
    ...H, data: { title: targetTitle, markdown: `# ${targetTitle}\n\n${targetMarker}` },
  })).json() as { id: string };
  const source = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Link source ${stamp}`, markdown: `Go to [[${targetTitle}]] now.\n\nSecond paragraph.` },
  })).json() as { id: string };
  return { source, target, targetTitle, targetMarker };
}

/** The centre of the link's text in the editor. */
async function linkCentre(page: Page, title: string) {
  const link = page.locator(".cm-content .cm-md-link", { hasText: title }).first();
  await expect(link).toBeVisible();
  const box = (await link.boundingBox())!;
  return { link, x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("desktop: Ctrl/Cmd+click", () => {
  test.beforeEach(({}, testInfo) => test.skip(!!testInfo.project.use.hasTouch, "desktop pointer only"));

  test("a plain click places the caret and stays; Ctrl/Cmd+click opens the note", async ({ page }) => {
    const { source, targetTitle, targetMarker } = await seed(page);
    await ready(page, `/?view=notes&node=${source.id}`);
    const { link } = await linkCentre(page, targetTitle);

    await link.click();
    await expect(page.locator(".cm-content")).not.toContainText(targetMarker);
    await expect(page.locator(".cm-content")).toContainText("Second paragraph.");

    // Ctrl/Cmd+click opens the note beside, on the right (views side by side,
    // #1073 useSplitView openBeside); the source stays on the left.
    await link.click({ modifiers: ["ControlOrMeta"] });
    const right = page.locator('.split-pane[data-split-side="right"]');
    await expect(right).toContainText(targetMarker, { timeout: 10_000 });
    await expect(page.locator(".cm-content").first()).toContainText("Second paragraph.");
    // The open right side is kept for the account (a server pref): close it so
    // later specs start on one pane.
    await right.getByRole("button", { name: "Close the right side" }).click();
    await expect(right).toHaveCount(0);
  });

  test("the pointer is a hand only while Ctrl/Cmd is held over a link", async ({ page }) => {
    const { source, targetTitle } = await seed(page);
    await ready(page, `/?view=notes&node=${source.id}`);
    const { link } = await linkCentre(page, targetTitle);
    const cursor = () => link.evaluate((el) => getComputedStyle(el).cursor);
    await link.hover();
    expect(await cursor()).not.toBe("pointer");
    await page.keyboard.down("ControlOrMeta");
    await expect.poll(cursor).toBe("pointer");
    await page.keyboard.up("ControlOrMeta");
    await expect.poll(cursor).not.toBe("pointer");
  });

  test("a URL opens in a new tab with noopener", async ({ page }) => {
    const stamp = Date.now();
    const note = await (await page.request.post("/api/nodes", {
      ...H, data: { title: `Url source ${stamp}`, markdown: `Docs: [guide](${BASE}/robots.txt?u=${stamp}) here` },
    })).json() as { id: string };
    await ready(page, `/?view=notes&node=${note.id}`);
    const { link } = await linkCentre(page, "guide");
    const popup = page.waitForEvent("popup");
    await link.click({ modifiers: ["ControlOrMeta"] });
    const tab = await popup;
    // A noopener popup can be reported before its first navigation commits (url ""):
    // wait for it to land on the link's address.
    await tab.waitForURL((url) => url.searchParams.get("u") === String(stamp));
    expect(tab.url()).toContain(`u=${stamp}`);
    expect(await tab.evaluate(() => window.opener)).toBeNull(); // noopener
  });
});

test.describe("phone: tap and chip", () => {
  test.beforeEach(({}, testInfo) => test.skip(!testInfo.project.use.hasTouch, "touch projects only"));

  test("a tap while the editor is not focused follows the link", async ({ page }) => {
    const { source, targetTitle, targetMarker } = await seed(page);
    await ready(page, `/?view=notes&node=${source.id}`);
    const { x, y } = await linkCentre(page, targetTitle);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // reading: keyboard closed

    await page.touchscreen.tap(x, y);
    await expect(page.locator(".cm-content")).toContainText(targetMarker, { timeout: 10_000 });
  });

  test("while writing a tap only places the caret, and the Open chip follows", async ({ page }) => {
    const { source, targetTitle, targetMarker } = await seed(page);
    await ready(page, `/?view=notes&node=${source.id}`);
    await page.locator(".cm-content").tap({ position: { x: 20, y: 60 } }); // focus: the keyboard opens
    const { x, y } = await linkCentre(page, targetTitle);

    await page.touchscreen.tap(x, y);
    await expect(page.locator(".cm-content")).not.toContainText(targetMarker);
    const chip = page.locator(".md-link-chip");
    await expect(chip).toBeVisible();
    // Above the caret's line: it must not cover the text being typed.
    const line = (await page.locator(".cm-content .cm-md-link", { hasText: targetTitle }).first().boundingBox())!;
    const chipBox = (await chip.boundingBox())!;
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(line.y + 1);
    // Drawn smaller; the 44px touch area is its invisible ::after.
    expect(await chip.evaluate((el) => parseFloat(getComputedStyle(el, "::after").height))).toBeGreaterThanOrEqual(44);

    await chip.tap();
    await expect(page.locator(".cm-content")).toContainText(targetMarker, { timeout: 10_000 });
  });

  test("the chip is gone when the caret leaves the link", async ({ page }) => {
    const { source, targetTitle } = await seed(page);
    await ready(page, `/?view=notes&node=${source.id}`);
    await page.locator(".cm-content").tap({ position: { x: 20, y: 60 } });
    const { x, y } = await linkCentre(page, targetTitle);
    await page.touchscreen.tap(x, y);
    await expect(page.locator(".md-link-chip")).toBeVisible();
    await page.getByText("Second paragraph.").tap();
    await expect(page.locator(".md-link-chip")).toHaveCount(0);
  });
});

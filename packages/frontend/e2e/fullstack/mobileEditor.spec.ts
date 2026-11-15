// Mobile editor regression: Enter must insert a line break under Android
// Chrome emulation. CM6's delayAndroidKey path waits for the virtual
// keyboard's own DOM mutation and silently drops the key when none arrives —
// MarkdownEditor now handles beforeinput insertParagraph/insertLineBreak
// directly (see the domEventHandlers comment there). Pixel-5 emulation is
// exactly the environment that reproduced the user's "Enter doesn't break
// lines on my phone" report.
import { test, expect, devices } from "@playwright/test";
import { ready, openQuickCapture } from "./helpers";

test.use({ ...devices["Pixel 5"] });

test("mobile: Enter breaks lines in the editor; checkbox lines continue", async ({ page }) => {
  const title = `mobile enter note ${Date.now()}`; // stamped — same-title leftovers from earlier runs break first-match clicks
  await ready(page);
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(title);
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".quick-capture-overlay")).toHaveCount(0);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  // Capture opens the new note once the sheet has closed and the store has
  // refreshed (BuilderApp openCaptured). Going back before that lands would
  // be overtaken by it, so wait for the captured note, then go to the list.
  await expect(page.locator(".obsidian-title-input").filter({ visible: true })).toHaveValue(title);
  await page.locator(".omt-back").click();
  await page.getByText(title, { exact: false }).first().click();

  const cm = page.locator(".cm-content").first();
  await cm.click();

  // plain Enter — the bug: this used to produce NO line break on Android
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect.poll(async () => cm.innerText()).toContain("first\nsecond");

  // task-list continuation still goes through the same Enter path
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] todo one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("todo two");
  await expect.poll(async () => cm.innerText()).toContain("- [ ] todo one\n- [ ] todo two");
});

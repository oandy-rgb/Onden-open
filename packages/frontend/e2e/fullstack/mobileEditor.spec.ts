// Mobile editor regression: Enter must insert a line break under Android
// Chrome emulation. CM6's delayAndroidKey path waits for the virtual
// keyboard's own DOM mutation and silently drops the key when none arrives —
// MarkdownEditor now handles beforeinput insertParagraph/insertLineBreak
// directly (see the domEventHandlers comment there). Pixel-5 emulation is
// exactly the environment that reproduced the user's "Enter doesn't break
// lines on my phone" report.
import { test, expect, devices } from "@playwright/test";
import { ready, H } from "./helpers";

test.use({ ...devices["Pixel 5"] });

test("mobile: Enter breaks lines in the editor; checkbox lines continue", async ({ page }) => {
  const title = `mobile enter note ${Date.now()}`; // stamped — same-title leftovers from earlier runs break first-match clicks
  // The note is made through the API: capture no longer opens the note it saved (the box stays open for the next
  // thought, 2026-10-29), and what this protects is the editor's Enter, not the way to the note.
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "" } })).json() as { id: string };
  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".obsidian-title-input").filter({ visible: true })).toHaveValue(title);

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
  // A `- [ ] ` line is drawn as a checkbox in the editor (so its text no longer reads "[ ]"): what Enter
  // continued is read from the saved note.
  await expect.poll(async () => ((await (await page.request.get(`/api/nodes/${note.id}`, H)).json()) as { markdown: string }).markdown)
    .toContain("first\nsecond\n- [ ] todo one\n- [ ] todo two");
});

import { test, expect, type Page } from "@playwright/test";
import { ready, renderSettled, pollBootstrap, openPublishRow } from "./helpers";

// Zero-prompt JOURNEY captures (PROBE=1): the things a new user tries first,
// unprompted — write a second note, tag it, organize it, publish it, find it,
// recover from a delete. Screenshot every affordance decision point.
const S = "/tmp/pw-output/shots";
const shot = async (page: Page, name: string) => {
  await renderSettled(page); // fonts + frames flushed — replaces fixed pre-shot sleeps
  await page.screenshot({ path: `${S}/${name}.png` });
};

test("journey captures", async ({ page }) => {
  test.skip(!process.env.PROBE, "capture only");
  test.setTimeout(240_000);

  await ready(page, "/?view=notes");

  // j1 — "I want a second note": the sidebar `+`.
  await page.locator(".sb-bar-btn, .obsidian-add-btn, button[title*='new' i], button[aria-label*='new' i]").first().screenshot({ path: `${S}/j-00-plus-btn.png` }).catch(() => {});
  const plusBtn = page.locator('button[aria-label="Create new node"], .sidebar-create-btn').first();
  await shot(page, "j-01-before-create");
  // The + sits in the sidebar toolbar; click whatever the "+" is.
  const candidates = page.locator("aside button, .obsidian-sidebar button").filter({ hasText: /^\+?$/ });
  if (await plusBtn.count()) await plusBtn.click();
  else if (await candidates.count()) await candidates.first().click();
  // Whatever the + opens (create menu / inline input) — wait for it, don't sleep.
  await page.getByText("Note", { exact: true }).first().or(page.locator(".obsidian-title-input").first())
    .waitFor({ timeout: 5_000 }).catch(() => {});
  await shot(page, "j-02-after-plus");
  // Pick "Note" from the create menu (the earlier run typed into the day note
  // because this click was missing — the menu itself was the screenshot).
  const noteItem = page.getByText("Note", { exact: true }).first();
  if (await noteItem.count()) {
    await noteItem.click();
    await page.locator(".obsidian-title-input, .cm-content").first().waitFor({ timeout: 10_000 }).catch(() => {}); // editor for the new note
  }

  // If a create dialog/inline input appeared, give it a title.
  const titleInput = page.locator(".obsidian-title-input").first();
  if (await titleInput.count()) {
    await titleInput.fill("我的第二篇筆記");
    // Title save is debounced — poll the server for it instead of sleeping.
    await pollBootstrap(page, (b) => b.nodes.find((n: { title: string }) => n.title === "我的第二篇筆記"),
      { timeout: 10_000 }).catch(() => {});
  }
  // j3 — type body with an inline #word (text, not a tag — T10): does anything light up?
  const cm = page.locator(".cm-content").first();
  if (await cm.count()) {
    await cm.click();
    await page.keyboard.type("這是內文，加上 #靈感 標籤與 [[2026", { delay: 25 });
    await shot(page, "j-03-typing-tag-wikilink"); // shot() settles decoration paint
    await page.keyboard.press("Escape");
  }

  // j4 — publish from the info panel's publish row: is "Publish" readable as a button?
  if (await page.locator(".notes-inspector-toggle").count()) {
    const { mark, unpublish } = await openPublishRow(page);
    await mark.scrollIntoViewIfNeeded();
    await shot(page, "j-04-inspector-private");
    await mark.click();
    // The row offers Unpublish once the mark persists — that's the condition.
    await expect(unpublish).toBeVisible({ timeout: 10_000 }).catch(() => {});
    await shot(page, "j-05-inspector-published");
  }

  // j6 — delete the note: what feedback / recovery affordance shows up?
  const row = page.locator(".obsidian-page-row", { hasText: "我的第二篇筆記" }).first();
  if (await row.count()) {
    await row.hover();
    const del = row.locator(".obsidian-delete-btn");
    if (await del.count()) {
      await del.click();
      // The row leaves the sidebar once the delete lands.
      await expect(row).toHaveCount(0, { timeout: 10_000 }).catch(() => {});
      await shot(page, "j-06-after-delete");
    }
  }

  // j7 — ⌘K palette: the universal "where is everything".
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette-input-wrap input").waitFor({ timeout: 10_000 }).catch(() => {}); // palette open
  await shot(page, "j-07-palette");
  await page.keyboard.press("Escape");

  // j8 — the three empty surfaces not yet reviewed (ready() waits the shell;
  // shot() settles the paint — empty states have no further anchor to await).
  await ready(page, "/?view=tasks");
  await shot(page, "j-08-empty-tasks");
  await ready(page, "/?view=timeline");
  await shot(page, "j-09-empty-timeline");
  await ready(page, "/?view=notes");
});

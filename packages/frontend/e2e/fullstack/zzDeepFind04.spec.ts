// Feature-audit deepening (2026-10-07): FIND-04 — backlinks / mentions update
// right after a save, removal clears them, clicking hands the caret to the
// link, and the phone shows the same under the note.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";

// The "Mentioned in N notes" cards under the note (NoteRelations; there is no "Backlinks" heading with a count any more):
// the linked cards, not the "Unlinked mentions" ones.
const backlinkCount = (page: Page) => page.locator(".backlink-card:not(.backlink-card--unlinked)").filter({ visible: true }).count();

test("FIND-04: backlinks follow saves, removal, caret handoff and phone", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const target = await (await page.request.post("/api/nodes", { ...H, data: { title: `Target${stamp}`, markdown: "target body" } })).json();
  const filler = Array.from({ length: 40 }, (_, i) => `filler line ${i}`).join("\n");
  const src = await (await page.request.post("/api/nodes", { ...H, data: { title: `Source${stamp}`, markdown: `${filler}\nend` } })).json();

  // Two tabs: editor on Source, Target open in a second page to watch its inspector live.
  await ready(page, `/?view=notes&node=${target.id}`);
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Target${stamp}`);
  expect(await backlinkCount(page), "a note nothing links to has no mention cards").toBe(0);
  const editorPage = await page.context().newPage();
  await ready(editorPage, `/?view=notes&node=${src.id}`);
  await editorPage.locator(".cm-content").click();
  await editorPage.keyboard.press("Control+End");
  await editorPage.keyboard.press("Enter");
  await editorPage.keyboard.insertText(`see [[Target${stamp}]] here`);
  await editorPage.keyboard.press("Control+s");
  // The open Target page shows the new mention live, without a reload (the spec's header; the elapsed time is not a check).
  await expect.poll(() => backlinkCount(page), { timeout: 20_000 }).toBe(1);
  // The card knows where the link is only once the source's text is in the app: wait for its quoted line, then click.
  const quoted = page.locator(".backlink-card-match").first();
  await expect(quoted).toBeVisible();
  await expect(quoted, "the card quotes the line with the link").toContainText(`Target${stamp}`);

  // Caret handoff: click the backlink → Source opens with the caret on the link, scrolled into view, editor focused.
  // (The link is flashed, not selected — 2026-11-02, MarkdownEditor mount-restore — so there is no DOM selection to read.)
  await page.locator(".backlink-card", { hasText: `Source${stamp}` }).first().click();
  await expect(page).toHaveURL(new RegExp(src.id));
  const linkLine = page.locator(".cm-line", { hasText: `Target${stamp}` });
  await expect(linkLine).toBeInViewport();
  await expect(page.locator(".cm-content")).toBeFocused();

  // Removal: delete the link in Source → Target's backlink count drops.
  await editorPage.locator(".cm-content").click();
  await editorPage.keyboard.press("Control+a");
  await editorPage.keyboard.insertText("no links any more");
  await editorPage.keyboard.press("Control+s");
  // The removal is saved before Target is looked at again; then its mention card is gone.
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${src.id}`, H)).json()).markdown, { timeout: 20_000 }).toBe("no links any more");
  await ready(page, `/?view=notes&node=${target.id}`);
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Target${stamp}`);
  await expect.poll(() => backlinkCount(page), { timeout: 20_000 }).toBe(0);

  // Unlinked mention: plain title text shows under "Unlinked mentions".
  await page.request.patch(`/api/nodes/${src.id}`, { ...H, data: { markdown: `mentions Target${stamp} without brackets` } });
  await ready(page, `/?view=notes&node=${target.id}`);
  // (lib/backlinks.ts findMentionSnippet: the title as plain text at a word boundary, not inside a [[link]].)
  await expect.poll(() => page.locator(".note-relations-section", { hasText: "Unlinked mentions" }).count(), { timeout: 15_000 }).toBe(1);
  // Same with a title made of words (no digits glued to letters).
  const worded = await (await page.request.post("/api/nodes", { ...H, data: { title: `Quantum Garden ${stamp % 1000}`, markdown: "w" } })).json();
  await page.request.post("/api/nodes", { ...H, data: { title: `Mentioner ${stamp}`, markdown: `I read about Quantum Garden ${stamp % 1000} today` } });
  await ready(page, `/?view=notes&node=${worded.id}`);
  await expect.poll(() => page.locator(".note-relations-section", { hasText: "Unlinked mentions" }).count(), { timeout: 15_000 }).toBe(1);

  // Phone: Info tab shows backlinks for a linked note.
  await page.request.patch(`/api/nodes/${src.id}`, { ...H, data: { markdown: `again [[Target${stamp}]]` } });
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${target.id}`);
  // The phone shows the same "Mentioned in" cards under the note body; there is no Info tab to open first.
  await expect.poll(() => backlinkCount(pp), { timeout: 15_000 }).toBe(1);
  const card = pp.locator(".backlink-card").first();
  const box = await card.boundingBox();
  // A phone tap target is at least 44 px and the page does not scroll sideways (frontend/e2e/layout-audit README: 手機點擊目標).
  expect(box!.height, "the card is a 44px tap target").toBeGreaterThanOrEqual(44);
  expect(await pp.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll on the phone").toBeLessThanOrEqual(390);
  await card.click();
  await expect(pp).toHaveURL(new RegExp(src.id));
  await phone.close();
});

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
  const out: Record<string, string> = {};

  // Two tabs: editor on Source, Target open in a second page to watch its inspector live.
  await ready(page, `/?view=notes&node=${target.id}`);
  out.initial = String(await backlinkCount(page));
  const editorPage = await page.context().newPage();
  await ready(editorPage, `/?view=notes&node=${src.id}`);
  await editorPage.locator(".cm-content").click();
  await editorPage.keyboard.press("Control+End");
  await editorPage.keyboard.press("Enter");
  await editorPage.keyboard.insertText(`see [[Target${stamp}]] here`);
  await editorPage.keyboard.press("Control+s");
  const t0 = Date.now();
  await expect.poll(() => backlinkCount(page), { timeout: 20_000 }).toBe(1);
  out.liveAfterSave = `${Date.now() - t0}ms`;
  // The card knows where the link is only once the source's text is in the app: wait for its quoted line, then click.
  const quoted = page.locator(".backlink-card-match").first();
  await expect(quoted).toBeVisible();
  out.snippet = JSON.stringify(await quoted.innerText());

  // Caret handoff: click the backlink → Source opens with the caret on the link, scrolled into view, editor focused.
  // (The link is flashed, not selected — 2026-11-02, MarkdownEditor mount-restore — so there is no DOM selection to read.)
  await page.locator(".backlink-card", { hasText: `Source${stamp}` }).first().click();
  await expect(page).toHaveURL(new RegExp(src.id));
  const linkLine = page.locator(".cm-line", { hasText: `Target${stamp}` });
  await expect(linkLine).toBeInViewport();
  await expect(page.locator(".cm-content")).toBeFocused();
  out.caret = `linkLineInView=${await linkLine.isVisible()}`;

  // Removal: delete the link in Source → Target's backlink count drops.
  await editorPage.locator(".cm-content").click();
  await editorPage.keyboard.press("Control+a");
  await editorPage.keyboard.insertText("no links any more");
  await editorPage.keyboard.press("Control+s");
  await ready(page, `/?view=notes&node=${target.id}`);
  await expect.poll(() => backlinkCount(page), { timeout: 20_000 }).toBe(0);
  out.afterRemoval = String(await backlinkCount(page));

  // Unlinked mention: plain title text shows under "Unlinked mentions".
  await page.request.patch(`/api/nodes/${src.id}`, { ...H, data: { markdown: `mentions Target${stamp} without brackets` } });
  await ready(page, `/?view=notes&node=${target.id}`);
  const unlinkedOk = await expect.poll(() => page.locator(".note-relations-section", { hasText: "Unlinked mentions" }).count(), { timeout: 15_000 }).toBe(1).then(() => true).catch(() => false);
  out.unlinked = String(unlinkedOk);
  // Same with a title made of words (no digits glued to letters).
  const worded = await (await page.request.post("/api/nodes", { ...H, data: { title: `Quantum Garden ${stamp % 1000}`, markdown: "w" } })).json();
  await page.request.post("/api/nodes", { ...H, data: { title: `Mentioner ${stamp}`, markdown: `I read about Quantum Garden ${stamp % 1000} today` } });
  await ready(page, `/?view=notes&node=${worded.id}`);
  out.unlinkedWords = String(await expect.poll(() => page.locator(".note-relations-section", { hasText: "Unlinked mentions" }).count(), { timeout: 15_000 }).toBe(1).then(() => true).catch(() => false));

  // Phone: Info tab shows backlinks for a linked note.
  await page.request.patch(`/api/nodes/${src.id}`, { ...H, data: { markdown: `again [[Target${stamp}]]` } });
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${target.id}`);
  // The phone shows the same "Mentioned in" cards under the note body; there is no Info tab to open first.
  await expect.poll(() => backlinkCount(pp), { timeout: 15_000 }).toBe(1);
  const card = pp.locator(".backlink-card").first();
  const box = await card.boundingBox();
  out.phone = `count=${await backlinkCount(pp)} cardHeight=${box ? Math.round(box.height) : "none"} docWidth=${await pp.evaluate(() => document.documentElement.scrollWidth)}`;
  await card.click();
  await expect(pp).toHaveURL(new RegExp(src.id));
  out.phoneOpens = "true";
  await phone.close();
  console.log(`AUDIT FIND-04 ${JSON.stringify(out)}`);
});

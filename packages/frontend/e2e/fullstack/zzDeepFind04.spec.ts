// Feature-audit deepening (2026-10-07): FIND-04 — backlinks / mentions update
// right after a save, removal clears them, clicking hands the caret to the
// link, and the phone Info tab shows the same.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";

const backlinkCount = async (page: Page) => {
  if (await page.getByText(/^No backlinks$|No linked notes yet/).filter({ visible: true }).count()) return 0;
  return Number((await page.locator(".note-relations-section", { hasText: "Backlinks" }).locator(".ov-panel-count").filter({ visible: true }).first().innerText({ timeout: 2000 }).catch(() => "-1")).trim());
};

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
  const snippet = await page.locator(".backlink-card-match").first().innerText().catch(() => "");
  out.snippet = JSON.stringify(snippet);

  // Caret handoff: click the backlink → Source opens with selection on the link.
  await page.locator(".backlink-card", { hasText: `Source${stamp}` }).first().click();
  await expect(page).toHaveURL(new RegExp(src.id));
  await page.waitForTimeout(1200);
  const sel = await page.evaluate(() => String(window.getSelection()));
  const lineVisible = await page.locator(".cm-line", { hasText: `Target${stamp}` }).isVisible().catch(() => false);
  out.caret = `selection=${JSON.stringify(sel.slice(0, 40))} linkLineInView=${lineVisible}`;

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
  await pp.getByText("Info", { exact: true }).filter({ visible: true }).first().click();
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

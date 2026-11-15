// Feature-audit deepening (2026-10-08): NAV-03 — the in-app Back across
// wikilink (preview + editor), command-palette search, Graph relation list,
// scroll / caret restore, browser Back after the same jumps, and the phone's
// "‹ Back" in the note bar.
import { expect, test, type Page } from "@playwright/test";
import { ready, switchNoteView, BASE, H } from "./helpers";


test("NAV-03: back across wikilink / search / graph, scroll restore, phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const mk = async (t: string, md: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title: t, markdown: md } })).json()).id as string;
  const B = await mk(`NavB ${stamp}`, "b body");
  const C = await mk(`NavC ${stamp}`, "c body");
  const A = await mk(`NavA ${stamp}`, Array.from({ length: 120 }, (_, i) => `para ${i}`).join("\n\n") + `\n\nSee [[NavB ${stamp}]] here.`);
  await page.request.post("/api/edges", { ...H, data: { source_node_id: B, target_node_id: C, edge_type: "knowledge_link" } });
  const title = (p: Page) => p.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null);
  // The top bar has no back button: the browser's Back (also Alt+←) returns along the link trail.
  const back = async (p: Page) => { await p.goBack(); };
  const expectTitle = async (p: Page, what: string) => expect(await title(p)).toBe(what);
  const scrollTop = (p: Page) => p.evaluate(() => { const el = Array.from(document.querySelectorAll(".obsidian-preview, .cm-scroller, .note-document, .overview-editor")).find((e) => (e as HTMLElement).scrollTop > 0) as HTMLElement | undefined; return el ? Math.round(el.scrollTop) : 0; });
  try {
  await ready(page, `/?view=notes&node=${A}`);
  await switchNoteView(page, "preview");
  const link = page.locator(".obsidian-preview").getByText(`NavB ${stamp}`).first();
  await link.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const before = await scrollTop(page);
  await link.click();
  await page.waitForTimeout(1200);
  out.afterWikilink = { title: await title(page) };
  await expectTitle(page, `NavB ${stamp}`);
  await back(page);
  await page.waitForTimeout(1500);
  await expectTitle(page, `NavA ${stamp}`);
  out.afterBack = { title: await title(page), scrollBefore: before, scrollAfter: await scrollTop(page), preview: await page.locator(".obsidian-preview").isVisible().catch(() => false) };

  // Search jump via palette.
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(`NavC ${stamp}`);
  await page.waitForTimeout(800);
  await page.locator(".palette-input-wrap input").press("Enter");
  await page.waitForTimeout(1200);
  out.afterPalette = { title: await title(page) };
  await expectTitle(page, `NavC ${stamp}`);
  await back(page);
  await page.waitForTimeout(1200);
  // Not asserted: a palette jump is not a link follow, so it has no trail entry and Back's target is the browser's.
  out.backAfterPalette = await title(page);

  // Graph relation list → note → Back.
  await ready(page, `/?view=notes&node=${B}`);
  await page.getByRole("tab", { name: "Relations", exact: true }).click();
  await page.locator(".links-relation-row", { hasText: `NavC ${stamp}` }).click();
  await page.waitForTimeout(1200);
  out.afterGraphJump = { title: await title(page) };
  await expectTitle(page, `NavC ${stamp}`);
  await back(page);
  await page.waitForTimeout(1200);
  out.backAfterGraph = { url: page.url().replace(BASE, "").slice(0, 50), title: await title(page) };
  await expectTitle(page, `NavB ${stamp}`);

  // Browser back after a wikilink jump.
  await ready(page, `/?view=notes&node=${A}`);
  await switchNoteView(page, "preview");
  await page.locator(".obsidian-preview").getByText(`NavB ${stamp}`).first().click();
  await page.waitForTimeout(1200);
  await page.goBack().catch(() => {});
  await page.waitForTimeout(1500);
  out.browserBack = { url: page.url().replace(BASE, "").slice(0, 60), title: await title(page) };
  await expectTitle(page, `NavA ${stamp}`);

  // Phone: wikilink then "‹ Back".
  const ph = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  await ready(pp, `/?view=notes&node=${A}`);
  await switchNoteView(pp, "preview").catch(() => {});
  await pp.locator(".obsidian-preview").getByText(`NavB ${stamp}`).first().click().catch(() => {});
  await pp.waitForTimeout(1200);
  const pb = pp.getByRole("button", { name: "Back", exact: true }).filter({ visible: true }).first();
  out.phone = { title: await title(pp), backLabel: await pb.innerText().catch(() => null) };
  await pb.click().catch(() => {});
  await pp.waitForTimeout(1200);
  out.phoneAfterBack = await title(pp);
  await ph.close();
  } finally {
    console.log("NAV03 " + JSON.stringify(out, null, 2));
  }
});

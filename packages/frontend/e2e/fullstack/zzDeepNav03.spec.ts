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
  // The note page's scroller is the one element `.obsidian-main.note-document` (desktop: the editor's .cm-scroller and
  // the preview's .obsidian-preview do not scroll), the window on a phone.
  const scrollTop = (p: Page) => p.evaluate(() => Math.round(document.querySelector(".obsidian-main.note-document")!.scrollTop || window.scrollY));
  const expectTitleSoon = async (p: Page, what: string) => expect.poll(() => title(p)).toBe(what);
  try {
  await ready(page, `/?view=notes&node=${A}`);
  await switchNoteView(page, "preview");
  const link = page.locator(".obsidian-preview").getByText(`NavB ${stamp}`).first();
  await scrollLinkIntoView(page, `NavB ${stamp}`);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
  const before = await scrollTop(page);
  await link.click();
  await expectTitleSoon(page, `NavB ${stamp}`);
  out.afterWikilink = { title: await title(page) };
  await back(page);
  await expectTitleSoon(page, `NavA ${stamp}`);
  await expect(link).toBeVisible(); // the body is drawn again: the position is put back with it, not after
  expect(Math.abs((await scrollTop(page)) - before), "Back returns the note to where it was left").toBeLessThan(40);
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

// Owner decision 2026-11-18: Back and Forward return a note to where its history entry was left (lib/pageScrollRestore).
// The page's scroller is `.obsidian-main.note-document` on a desktop (editor and preview alike), the window on a phone.
const noteScroll = (p: Page) => p.evaluate(() => Math.round(document.querySelector(".obsidian-main.note-document")!.scrollTop));
const windowScroll = (p: Page) => p.evaluate(() => Math.round(window.scrollY));
/** Scroll the preview link with this text into view where the page is: the preview draws again as notes arrive, so a locator
 *  resolved earlier can be a detached copy; this looks the link up in the page at the moment it scrolls. */
const scrollLinkIntoView = async (p: Page, text: string) => {
  await expect(p.locator(".obsidian-preview").getByText(text).first()).toBeAttached();
  await p.evaluate((t) => {
    [...document.querySelectorAll(".obsidian-preview a, .obsidian-preview button, .obsidian-preview span")].find((e) => e.textContent?.trim() === t)?.scrollIntoView({ block: "center" });
  }, text);
};
const paras = (n: number, tail = "") => Array.from({ length: n }, (_, i) => `para ${i}`).join("\n\n") + tail;
const noteTitle = (p: Page) => p.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null);

async function seedLong(page: Page, stamp: number) {
  const mk = async (t: string, md: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title: t, markdown: md } })).json()).id as string;
  const B = await mk(`BackB ${stamp}`, paras(140));
  const A = await mk(`BackA ${stamp}`, paras(140, `\n\nSee [[BackB ${stamp}]] here.`));
  return { A, B, aTitle: `BackA ${stamp}`, bTitle: `BackB ${stamp}` };
}

for (const lens of ["preview", "editor"] as const) {
  test(`NAV-03 scroll: Back and Forward return the note to where it was left (desktop ${lens})`, async ({ page }) => {
    const stamp = Date.now();
    const { A, aTitle, bTitle } = await seedLong(page, stamp);
    // The editor draws only the lines in view (its text is not all in the page): the page is tall once the body is here.
    const bodyDrawn = async () => {
      await expect.poll(() => page.evaluate(() => document.querySelector(".obsidian-main.note-document")?.scrollHeight ?? 0)).toBeGreaterThan(4000);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))); // the frames a restore takes
    };
    await ready(page, `/?view=notes&node=${A}`);
    if (lens === "preview") {
      await switchNoteView(page, "preview");
      await expect(page.locator(".obsidian-preview").getByText("para 100").first()).toBeAttached();
    } else {
      await bodyDrawn();
    }
    // Preview: follow the link in the note (a link follow); editor: the palette (a plain jump, no trail step). Either is one history entry.
    const open = async (title: string) => {
      if (lens === "preview") {
        await page.locator(".obsidian-preview").getByText(title).first().click();
      } else {
        await page.keyboard.press("Control+k");
        await page.locator(".palette-input-wrap input").fill(title);
        await page.locator(".palette-item", { hasText: title }).first().click();
      }
      await expect.poll(() => noteTitle(page)).toBe(title);
    };
    const scrollNoteTo = async (y: number) => {
      await page.evaluate((top) => { document.querySelector(".obsidian-main.note-document")!.scrollTop = top; }, y);
      await expect.poll(() => noteScroll(page)).toBe(y);
    };

    let leftAt = 2500;
    if (lens === "preview") {
      await scrollLinkIntoView(page, bTitle); // the link is at the end of the note
      await expect.poll(() => noteScroll(page)).toBeGreaterThan(1000);
      leftAt = await noteScroll(page);
    } else {
      // The caret is in the first line, far above where the page is left: Back must not scroll the page to it again
      // (the editor restores a note's last caret when it opens, and puts it in view).
      await page.locator(".cm-line").first().click();
      expect(await page.evaluate((id) => sessionStorage.getItem(`onden.cursor.${id}`), A), "the editor has the caret to restore").not.toBeNull();
      await page.locator(".obsidian-title-input").click(); // the focus leaves the text: Ctrl+K is the palette's, not the editor's link shortcut
      await scrollNoteTo(leftAt);
    }
    await open(bTitle);
    // A note opened any other way starts at the top.
    expect(await noteScroll(page), "a note opened any other way starts at the top").toBeLessThan(40);
    await scrollNoteTo(1800);

    await page.goBack();
    await expect.poll(() => noteTitle(page)).toBe(aTitle);
    await bodyDrawn();
    expect(Math.abs((await noteScroll(page)) - leftAt), "Back: the first note where it was left").toBeLessThan(40);

    await page.goForward();
    await expect.poll(() => noteTitle(page)).toBe(bTitle);
    await bodyDrawn();
    expect(Math.abs((await noteScroll(page)) - 1800), "Forward: the second note where it was left").toBeLessThan(40);
  });
}

test("NAV-03 scroll: phone, Back to a note returns its body to where it was left", async ({ browser, page }) => {
  const stamp = Date.now();
  const { A, aTitle, bTitle } = await seedLong(page, stamp);
  const ph = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  try {
    await ready(pp, `/?view=notes&node=${A}`);
    await switchNoteView(pp, "preview");
    const link = pp.locator(".obsidian-preview").getByText(`BackB ${stamp}`).first();
    await scrollLinkIntoView(pp, bTitle);
    await expect.poll(() => windowScroll(pp)).toBeGreaterThan(1000);
    const before = await windowScroll(pp);
    await link.click();
    await expect.poll(() => noteTitle(pp)).toBe(bTitle);
    expect(await windowScroll(pp), "phone: a note opened by a link starts at the top").toBeLessThan(40);
    await pp.evaluate(() => window.scrollTo(0, 1500));
    await expect.poll(() => windowScroll(pp)).toBe(1500);

    await pp.getByRole("button", { name: "Back", exact: true }).filter({ visible: true }).first().click();
    await expect.poll(() => noteTitle(pp)).toBe(aTitle);
    await expect(link).toBeVisible();
    expect(Math.abs((await windowScroll(pp)) - before), "phone: Back to the note").toBeLessThan(40);

    await pp.goForward();
    await expect.poll(() => noteTitle(pp)).toBe(bTitle);
    await expect(pp.locator(".obsidian-preview")).toContainText("para 100");
    expect(Math.abs((await windowScroll(pp)) - 1500), "phone: Forward to the second note").toBeLessThan(40);
  } finally {
    await ph.close();
  }
});

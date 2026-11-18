// Feature-audit deepening (2026-10-08): NOTE-04 — Markdown rendering: a long
// note, a 200-row table, malformed syntax, hostile HTML/URLs (sanitising) in
// the editor Preview and on the published page, and differences between them.
// The published page is reached the current way: the notes are made in a space that publishes (「發布到網站」), not marked one by one.
import { test, expect, type Page } from "@playwright/test";
import { ready, switchNoteView, BASE, H, createPublishingSpace, publishSite } from "./helpers";


test("NOTE-04: long text, big table, malformed syntax, sanitising, preview vs site", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  const hostile = [
    "# Hostile", "", "<script>window.__xss1=1</script>", "", "<img src=x onerror=\"window.__xss2=1\">", "",
    "[js link](javascript:window.__xss3=1)", "", "<iframe src=\"javascript:window.__xss4=1\"></iframe>", "",
    "<svg onload=\"window.__xss5=1\"><circle r=5/></svg>", "", "<a href=\"data:text/html,<script>1</script>\">data link</a>", "",
    "<details><summary>Sum</summary>inner text</details>", "", "<u>under</u> <mark>mark</mark> <kbd>K</kbd>", "",
    "<div style=\"position:fixed;inset:0;background:red\">overlay</div>", "",
  ].join("\n");
  const malformed = ["```js", "unclosed fence", "", "| a | b |", "|---|", "| 1 | 2 | 3 |", "", "**bold without end", "", "[[", "", "$$ x^2 ", "", "- [ ] task", "  - [x nested broken", "", "Inline $e^{i\\pi}+1=0$ math", "", "$$", "\\int_0^1 x\\,dx", "$$"].join("\n");
  const table = ["| " + Array.from({ length: 10 }, (_, i) => `c${i}`).join(" | ") + " |", "|" + " --- |".repeat(10), ...Array.from({ length: 200 }, (_, r) => "| " + Array.from({ length: 10 }, (_, c) => `r${r}c${c}`).join(" | ") + " |")].join("\n");
  const long = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} 中文段落 with some **bold** and \`code\`.`).join("\n\n");
  const space_id = await createPublishingSpace(page.request);
  const mk = async (title: string, markdown: string, inSpace = false) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, ...(inSpace ? { space_id } : {}) } })).json()) as { id: string; slug: string };
  const nH = await mk(`MdHostile ${stamp}`, hostile + "\n\n" + malformed, true);
  const nT = await mk(`MdTable ${stamp}`, table, true);
  const nL = await mk(`MdLong ${stamp}`, long);
  const openPreview = async (p: Page, id: string, shows: string | RegExp) => {
    await ready(p, `/?view=notes&node=${id}`);
    await switchNoteView(p, "preview");
    await expect(p.locator(".obsidian-preview")).toBeVisible({ timeout: 30_000 });
    await expect(p.locator(".obsidian-preview")).toContainText(shows, { timeout: 30_000 });
  };
  const xss = (p: Page) => p.evaluate(() => [1, 2, 3, 4, 5].filter((i) => (window as unknown as Record<string, unknown>)[`__xss${i}`]).map((i) => `xss${i}`));
  const describe = (p: Page, root: string) => p.locator(root).first().evaluate((r) => ({
    scripts: r.querySelectorAll("script").length, iframes: Array.from(r.querySelectorAll("iframe")).map((f) => f.getAttribute("src")),
    onAttrs: Array.from(r.querySelectorAll("*")).filter((e) => Array.from(e.attributes).some((a) => a.name.startsWith("on"))).length,
    hrefs: Array.from(r.querySelectorAll("a")).map((a) => a.getAttribute("href")).filter((h) => h && /javascript|data:/i.test(h)),
    fixedOverlay: Array.from(r.querySelectorAll("div")).some((d) => getComputedStyle(d).position === "fixed"),
    details: r.querySelectorAll("details").length, kbd: r.querySelectorAll("kbd").length, markU: r.querySelectorAll("mark,u").length, svg: r.querySelectorAll("svg circle").length,
    katex: r.querySelectorAll(".katex").length, codeBlocks: r.querySelectorAll("pre code").length, tables: r.querySelectorAll("table").length,
    text: (r as HTMLElement).innerText.replace(/\s+/g, " "),
  }));
  // None of the hostile HTML runs, in the app or on the site: the one sanitize schema (markdown/src/sanitizeSchema.ts) takes out
  // scripts, event attributes, javascript:/data: links, untrusted iframes, svg and style, on every surface.
  const expectInert = (d: Awaited<ReturnType<typeof describe>>, where: string) => {
    expect(d.scripts, `${where}: no script element`).toBe(0);
    expect(d.iframes, `${where}: no iframe`).toEqual([]);
    expect(d.onAttrs, `${where}: no event attribute`).toBe(0);
    expect(d.hrefs, `${where}: no javascript: or data: link`).toEqual([]);
    expect(d.fixedOverlay, `${where}: style is stripped, so nothing can cover the page`).toBe(false);
    expect(d.svg, `${where}: no inline svg`).toBe(0);
  };

  // Preview: the allowed HTML renders (details, kbd, u, mark: the default schema's tags and the two the editor writes), the rest is gone.
  await openPreview(page, nH.id, "Hostile");
  const hostilePreview = await describe(page, ".obsidian-preview");
  expectInert(hostilePreview, "app preview");
  expect(await xss(page), "no hostile code ran in the app").toEqual([]);
  expect(hostilePreview.details, "app preview keeps <details>").toBe(1);
  expect(hostilePreview.kbd, "app preview keeps <kbd>").toBe(1);
  expect(hostilePreview.markU, "app preview keeps <u> and <mark>").toBe(2);
  expect(hostilePreview.text, "app preview: the script's code is dropped, not shown").not.toContain("__xss1");
  // The link text stays when the dangerous address is taken away.
  expect(hostilePreview.text).toContain("js link");
  expect(hostilePreview.text).toContain("data link");
  // An unclosed code fence runs to the end of the note (CommonMark §4.5), so the malformed syntax after it is code, not a table or math.
  expect(hostilePreview.codeBlocks, "the unclosed fence is one code block").toBe(1);
  expect(hostilePreview.tables).toBe(0);
  expect(hostilePreview.katex).toBe(0);

  await openPreview(page, nT.id, "r199c9");
  const tablePreview = await page.locator(".obsidian-preview table").first().evaluate((t) => ({
    headerCells: t.querySelectorAll("thead th").length, bodyRows: t.querySelectorAll("tbody tr").length,
    scrollW: (t.parentElement as HTMLElement).scrollWidth, clientW: (t.parentElement as HTMLElement).clientWidth, pageSW: document.documentElement.scrollWidth, vw: innerWidth,
  }));
  expect(tablePreview.headerCells, "the 10 columns").toBe(10);
  expect(tablePreview.bodyRows, "all 200 rows").toBe(200);
  expect(tablePreview.pageSW, "the page does not scroll sideways").toBeLessThanOrEqual(tablePreview.vw);
  expect(tablePreview.scrollW, "the table fits its wrapper").toBeLessThanOrEqual(tablePreview.clientW); // pinned: today's behaviour, no written rule

  // A long note shows all of its text: the last paragraph is on the page.
  await openPreview(page, nL.id, "Paragraph 0 ");
  await expect(page.locator(".obsidian-preview").getByText("Paragraph 2999 ", { exact: false })).toHaveCount(1);
  // Typing at the end of the long note in the editor lands there.
  await switchNoteView(page, "edit");
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("typed at end of long note");
  await expect(page.locator(".cm-content")).toContainText("typed at end of long note");

  // Published page for the hostile note: the notes are in a publishing space.
  await publishSite(page.request);
  const anon = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const ap = await anon.newPage();
  const anonDialogs: string[] = [];
  ap.on("dialog", (d) => { anonDialogs.push(d.message()); void d.dismiss(); });
  const slugOf = async (id: string) => (await (await page.request.get(`/api/nodes/${id}`, H)).json()).slug as string;
  await ap.goto(`${BASE}/site/${await slugOf(nH.id)}`, { waitUntil: "load" });
  await expect(ap.locator("article")).toContainText("Hostile");
  const sitePage = await describe(ap, "article");
  expectInert(sitePage, "site");
  expect(await xss(ap), "no hostile code ran on the site").toEqual([]);
  // The published profile does not take inline HTML: it is shown as text, except the tags the editor itself writes (<u>, <mark>)
  // (docs/architecture/site-render-model.md: published 不吃內嵌 HTML).
  expect(sitePage.details, "site: <details> is text").toBe(0);
  expect(sitePage.kbd, "site: <kbd> is text").toBe(0);
  expect(sitePage.text, "site: the script is shown as text").toContain("<script>window.__xss1=1</script>");
  const raw = await (await ap.request.get(`/site/${await slugOf(nH.id)}`)).text();
  expect(raw, "the script is not in the page as a script").not.toContain("<script>window.__xss1");
  await ap.goto(`${BASE}/site/${await slugOf(nT.id)}`, { waitUntil: "load" });
  await expect(ap.locator("table").first()).toBeVisible();
  const siteTable = await ap.locator("table").first().evaluate((t) => ({ rows: t.querySelectorAll("tr").length, pageSW: document.documentElement.scrollWidth, vw: innerWidth }));
  expect(siteTable.rows, "the site shows the whole table").toBe(201);
  expect(siteTable.pageSW, "and does not scroll sideways").toBeLessThanOrEqual(siteTable.vw);
  expect(dialogs, "no dialog opened in the app").toEqual([]);
  expect(anonDialogs, "no dialog opened on the site").toEqual([]);
  await anon.close();
});

// Feature-audit deepening (2026-10-08): NOTE-04 — Markdown rendering: a long
// note, a 200-row table, malformed syntax, hostile HTML/URLs (sanitising) in
// the editor Preview and on the published page, and differences between them.
import { test, expect, type Page } from "@playwright/test";
import { ready, switchNoteView, BASE, H, publishRequest } from "./helpers";


test("NOTE-04: long text, big table, malformed syntax, sanitising, preview vs site", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
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
  const mk = async (title: string, markdown: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()) as { id: string; slug: string };
  const nH = await mk(`MdHostile ${stamp}`, hostile + "\n\n" + malformed);
  const nT = await mk(`MdTable ${stamp}`, table);
  const nL = await mk(`MdLong ${stamp}`, long);
  const openPreview = async (p: Page, id: string) => {
    const t0 = Date.now();
    await ready(p, `/?view=notes&node=${id}`);
    await switchNoteView(p, "preview");
    await expect(p.locator(".obsidian-preview")).toBeVisible({ timeout: 30_000 });
    await p.waitForTimeout(1500);
    return Date.now() - t0;
  };
  const xss = (p: Page) => p.evaluate(() => [1, 2, 3, 4, 5].filter((i) => (window as unknown as Record<string, unknown>)[`__xss${i}`]).map((i) => `xss${i}`));
  const describe = (p: Page, root: string) => p.locator(root).first().evaluate((r) => ({
    scripts: r.querySelectorAll("script").length, iframes: Array.from(r.querySelectorAll("iframe")).map((f) => f.getAttribute("src")),
    onAttrs: Array.from(r.querySelectorAll("*")).filter((e) => Array.from(e.attributes).some((a) => a.name.startsWith("on"))).length,
    hrefs: Array.from(r.querySelectorAll("a")).map((a) => a.getAttribute("href")).filter((h) => h && /javascript|data:/i.test(h)),
    fixedOverlay: Array.from(r.querySelectorAll("div")).some((d) => getComputedStyle(d).position === "fixed"),
    details: r.querySelectorAll("details").length, kbd: r.querySelectorAll("kbd,mark,u").length, svg: r.querySelectorAll("svg circle").length,
    katex: r.querySelectorAll(".katex").length, codeBlocks: r.querySelectorAll("pre code").length, tables: r.querySelectorAll("table").length,
    text: (r as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 120),
  }));
  try {
  out.hostilePreviewMs = await openPreview(page, nH.id);
  out.hostilePreview = await describe(page, ".obsidian-preview");
  out.xssPreview = await xss(page);
  out.tablePreviewMs = await openPreview(page, nT.id);
  out.tablePreview = await page.locator(".obsidian-preview table").first().evaluate((t) => ({ rows: t.querySelectorAll("tr").length, cols: t.querySelectorAll("tr:first-child th, tr:first-child td").length, scrollW: (t.parentElement as HTMLElement).scrollWidth, clientW: (t.parentElement as HTMLElement).clientWidth, pageSW: document.documentElement.scrollWidth })).catch(() => null);
  out.longPreviewMs = await openPreview(page, nL.id);
  await page.locator(".obsidian-preview").getByText("Paragraph 2999 ", { exact: false }).scrollIntoViewIfNeeded().catch(() => {});
  out.longLastVisible = await page.locator(".obsidian-preview").getByText("Paragraph 2999 ", { exact: false }).isVisible().catch(() => false);
  // Typing latency at the end of the long note in the editor.
  await switchNoteView(page, "edit").catch(() => {});
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Control+End");
  const k0 = Date.now(); await page.keyboard.type("typed at end of long note"); out.longTypeMs = Date.now() - k0;

  // Published page for the hostile note.
  await page.request.put(`/api/nodes/${nH.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await page.request.put(`/api/nodes/${nT.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  const pub = await publishRequest(page.request, {});
  out.publish = pub.status();
  const anon = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const ap = await anon.newPage();
  const anonDialogs: string[] = [];
  ap.on("dialog", (d) => { anonDialogs.push(d.message()); void d.dismiss(); });
  await expect.poll(async () => (await ap.request.get(`/site/${nH.slug}`)).status(), { timeout: 20_000 }).toBe(200).catch(() => {});
  await ap.goto(`${BASE}/site/${nH.slug}`, { waitUntil: "load" });
  await ap.waitForTimeout(3000);
  const root = (await ap.locator("article").count()) ? "article" : "main";
  out.sitePage = await describe(ap, root);
  out.xssSite = await xss(ap);
  out.siteRawHasScript = (await (await ap.request.get(`/site/${nH.slug}`)).text()).includes("__xss1");
  await ap.goto(`${BASE}/site/${nT.slug}`, { waitUntil: "load" });
  await ap.waitForTimeout(1500);
  out.siteTable = await ap.locator("table").first().evaluate((t) => ({ rows: t.querySelectorAll("tr").length, pageSW: document.documentElement.scrollWidth, vw: innerWidth })).catch(() => null);
  out.dialogs = { app: dialogs, site: anonDialogs };
  await anon.close();
  } finally {
    console.log("NOTE04 " + JSON.stringify(out, null, 2));
  }
});

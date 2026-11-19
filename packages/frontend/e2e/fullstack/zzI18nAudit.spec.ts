// zh-TW sweep: open each main screen in Traditional Chinese and list any
// English UI text left (text nodes and title / aria-label / placeholder).
// Fixture content is Chinese, so English found is UI chrome. Prints a report;
// fails only when English is found, so a clean run proves the sweep.
// A note's own words are user content wherever they show, the same as its title: the heading outline at the edge of an open note
// (.note-edge-outline), a history row's text sample (.wh-note-sample) and its 「added N paragraphs under <headings>」 line
// (.wh-note-meta, whose only non-Chinese words are the note's headings). Other specs leave English-headed notes (templates,
// the palette's Daily note) in the shared workspace, and this screen sweep runs after them.
// Note titles and space names are the user's content wherever they appear
// (a list row, its 「開啟 {title}」 tooltip, a sidebar space group), so the
// workspace's titles and spaces are cut out before the check, and a history
// entry's title button (which also names deleted notes) is skipped: the first-run example notes are English when the
// account was made in English (global-setup), and other specs leave English
// titles in the shared workspace.
import { test, expect, type Page } from "@playwright/test";
import { ready, PAGE } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";

// Words that are fine in a Chinese UI: product/format names and key labels.
const ALLOWED = /^(Onden|RSS|OPML|PDF|Markdown|BibTeX|DOI|URL|AI|API|CSS|HTML|JSON|JSON Canvas|Obsidian|Notion|Puck|E2E|Esc|Enter|Tab|Shift|Ctrl|Cmd|Alt|OK|ID|UUID|SQLite|Git|GitHub|Google|Tailscale|PWA|OAuth|MCP|zh-TW|English|SVG|PNG|JPG|WebP|CSV|ZIP|HTTP|HTTPS|Excalidraw|React|Flow|canvas|Anki|Zotero|Bluesky|Mastodon|PPTX|SKILL|Logseq|Haskell|Elixir|Dockerfile|PowerShell|LaTeX|App|Del)$/i;
// SKILL (the SKILL.md file), Logseq, and the language names in the "What's new" text are names of things, like the
// formats above; "App" is the loanword the zh-TW UI uses for the installed app; Del is a key label like Esc/Enter.

async function englishOn(page: Page, noteTitles: string[]): Promise<string[]> {
  return page.evaluate(({ allowed, titles }) => {
    const allowRe = new RegExp(allowed, "i");
    // Longest first, so a title that contains another is cut out whole.
    const userTitles = titles.filter((title) => /[A-Za-z]{3,}/.test(title)).sort((a, b) => b.length - a.length);
    const found = new Set<string>();
    // Puck's own editor chrome (undo/redo, sidebar toggles, "Blocks"/"Outline") is
    // third-party and not localizable; our block names inside it are checked.
    // The site preview's page bodies and page-list entries (title + excerpt)
    // are notes' text, the user's content like the editor's.
    const puckChrome = (el: Element | null) => !!el?.closest("[class*='PuckHeader'], [class*='PuckLayout-leftSideBar'] h2, [class*='SidebarSection-title'], [class*='Loader'], [class*='IconButton'], [class*='ViewportControls']");
    const skip = (el: Element | null) => puckChrome(el) || !!el?.closest(".cm-content, .cm-editor, .obsidian-title-input, .day-lens-row-title, .sb-item-title, .sidebar-node, [data-user-content], .react-flow__node, .card-node, script, style, code, pre, .tiptap, .markdown-body, .md-preview, .published-body, .published-page-list-item, .tl-title-btn, .note-edge-outline, .wh-note-sample, .wh-note-meta");
    const consider = (raw: string, where: string) => {
      let text = raw.replace(/\s+/g, " ").trim();
      for (const title of userTitles) if (text.includes(title)) text = text.split(title).join(" ").replace(/\s+/g, " ").trim();
      if (!/[A-Za-z]{3,}/.test(text)) return;
      if (/^[#@]/.test(text) || /^https?:/.test(text) || /@\w+\.\w+/.test(text)) return;
      // Tag names (#review) are the user's content wherever they appear.
      const words = text.replace(/#[^\s#，。、：；（）「」]+/g, "").match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
      if (words.every((w) => allowRe.test(w))) return;
      // Known exceptions: Puck's built-in editor chrome (no i18n support) and
      // standard vocabulary names inside Chinese descriptions.
      if (/^(Blocks|Outline|React Flow attribution)$/.test(text) || /^Collapse /.test(text)) return;
      if (/Schema\.org|FOAF/.test(text) && /[\u3400-\u9fff]/.test(text)) return;
      // A Chinese sentence that only names something (Schema.org, FSRS, agent).
      const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
      if (han >= 6 && words.join("").length < han) return;
      found.add(`${where}: ${text.slice(0, 90)}`);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || skip(el)) continue;
      // "#{name}" renders as two text nodes ("#", "review"): the element's
      // text shows it is a tag name, the user's content.
      if (/^[#@]/.test((el.textContent ?? "").trim())) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (!(el as HTMLElement).offsetParent && style.position !== "fixed") continue;
      consider(n.textContent ?? "", "text");
    }
    for (const el of Array.from(document.querySelectorAll("[title], [aria-label], [placeholder]"))) {
      if (skip(el)) continue;
      for (const a of ["title", "aria-label", "placeholder"]) {
        const v = el.getAttribute(a);
        if (v) consider(v, a);
      }
    }
    return [...found].sort();
  }, { allowed: ALLOWED.source, titles: noteTitles });
}

test("zh-TW: no English left on the main screens", async ({ page }) => {
  test.setTimeout(300_000);
  const H = { headers: PAGE };
  await page.addInitScript(() => {
    localStorage.setItem("onden.locale", "zh-TW");
    localStorage.setItem("onden.welcomeDismissed", "1");
  });
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: {
    name: `課程${stamp}`, fields: [{ name: "作者", type: "text" }],
  } })).json() as { id: string };
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `中文筆記${stamp}`, markdown: "內容" } })).json() as { id: string };
  await page.request.post("/api/nodes", { ...H, data: { title: `子筆記${stamp}`, markdown: "子", parent_id: note.id } });
  await Promise.all([page.request.put(`/api/nodes/${note.id}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(page.request, note.id)]);

  const spaces = ((await (await page.request.get("/api/spaces")).json()).spaces as Array<{ name?: string }>);
  const noteTitles = [
    ...((await (await page.request.get("/api/bootstrap")).json()).nodes as Array<{ title?: string }>).map((node) => node.title),
    ...spaces.map((space) => space.name),
  ].map((name) => name?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean);
  const report: Record<string, string[]> = {};
  const visit = async (name: string, url: string, then?: () => Promise<void>) => {
    await ready(page, url);
    await page.waitForTimeout(1200);
    if (then) { await then(); await page.waitForTimeout(800); }
    const hits = await englishOn(page, noteTitles);
    if (hits.length) report[name] = hits;
  };

  await visit("note editor", `/?view=notes&node=${note.id}`);
  await visit("note inspector", `/?view=notes&node=${note.id}`, async () => {
    const toggle = page.locator(".notes-inspector-toggle");
    if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
  });
  await visit("note canvas", `/?view=notes&node=${note.id}&lens=canvas`);
  // (The Table lens is gone, #486: the sub-notes are a section of the note
  // editor page visited above.)
  await visit("tag page", `/?view=notes&node=${tag.id}`);
  await visit("tags overview", "/?view=tags");
  await visit("tasks", "/?view=tasks");
  await visit("history", "/?view=timeline");
  await visit("graph", "/?view=graph");
  for (const module of ["review", "rss", "website"]) {
    await visit(`module ${module}`, `/?view=${module}`);
  }
  await visit("command palette", "/?view=notes", async () => {
    await page.keyboard.press("Control+k");
  });
  await visit("create menu", "/?view=notes", async () => {
    await page.locator(".sidebar-add, .ov-sidebar-add, [aria-label='新增']").first().click().catch(() => {});
  });
  await visit("tag canvas lens", `/?view=notes&node=${tag.id}&lens=canvas`);
  await visit("note context menu", `/?view=notes&node=${note.id}`, async () => {
    await page.locator(".obsidian-sidebar").getByText(`中文筆記${stamp}`).first().click({ button: "right" });
  });
  await visit("inbox", "/?view=notes", async () => {
    await page.getByRole("button", { name: "收件匣" }).first().click();
  });
  await visit("tag input", `/?view=notes&node=${note.id}`, async () => {
    // The note's tag row under its title.
    await page.locator(".note-document .title-tag-row .prop-tag--add").click();
    await page.locator(".title-tag-input").fill("zz");
  });
  // Settings: every section.
  await ready(page, "/?view=notes");
  await page.getByRole("button", { name: "設定" }).first().click();
  const sections = page.locator(".settings-nav-item");
  const count = await sections.count();
  for (let i = 0; i < count; i++) {
    await sections.nth(i).click();
    await page.waitForTimeout(600);
    const label = (await sections.nth(i).innerText()).trim();
    const hits = await englishOn(page, noteTitles);
    if (hits.length) report[`settings ${label}`] = hits;
  }

  console.log("I18N-AUDIT " + JSON.stringify(report, null, 1));
  for (const id of [note.id, tag.id]) await page.request.delete(`/api/nodes/${id}`, H);
  expect(Object.keys(report)).toEqual([]);
});

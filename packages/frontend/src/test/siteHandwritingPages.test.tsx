// A published handwriting note's own page (backend handwritingPages.ts writes
// the pages as `![][ink-page-N]` with the address `/api/media/<id>.svg#ink-page-N`
// after the note's text): the site draws them in order as full-width sheets
// (the renderer marks them by that address, never by an alt), with an alt in the
// site's language, lazily; the feed carries the first page; the cover is never a sheet.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { handwritingPageMarkdown, loadAllEnhancers, noteSummary } from "@onden/markdown";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { makeSiteMarkdown } from "../components/siteFrame";
import { coverImage } from "../components/siteFrame";
import { feedBodyHtml } from "../pages/site/_siteFeedBody";
import { shareImageUrl } from "../lib/siteShareImage";
import type { PublishedNode } from "../components/templates";

const MARKDOWN = ["Notes in words.", ...["aaaa", "bbbb", "cccc"].map((id, i) => handwritingPageMarkdown(i + 1, `/api/media/${id}.svg`))].join("\n\n");
const note = { id: "h", node_type: "content", title: "Lecture", slug: "lecture", markdown: MARKDOWN } as PublishedNode;

beforeAll(async () => { await loadAllEnhancers(); });

const imgs = (html: string) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

const altsOf = (html: string) => imgs(html).map((i) => /alt="([^"]*)"/.exec(i)![1]);

describe("handwriting pages on the site", () => {
  const html = renderToStaticMarkup(makeSiteMarkdown([note], { static: true })(MARKDOWN, "h"));

  it("text first, then the pages in order, each with its own alt", () => {
    expect(html.indexOf("Notes in words.")).toBeLessThan(html.indexOf("手寫第 1 頁"));
    expect(altsOf(html)).toEqual(["手寫第 1 頁", "手寫第 2 頁", "手寫第 3 頁"]);
    expect(imgs(html).map((i) => /src="([^"]*)"/.exec(i)![1])).toEqual(["/api/media/aaaa.svg#ink-page-1", "/api/media/bbbb.svg#ink-page-2", "/api/media/cccc.svg#ink-page-3"]);
  });

  it("the alt is in the site's language, in the page and in a feed", () => {
    const render = (locale: string) => renderToStaticMarkup(makeSiteMarkdown([note], { static: true, locale })(MARKDOWN, "h"));
    expect(altsOf(render("en"))[1]).toBe("Handwriting, page 2");
    expect(altsOf(render("ja"))[0]).toBe("手書き 1 ページ目");
    const feed = feedBodyHtml([note], note, "https://garden.example", "en");
    expect(altsOf(feed)).toEqual(["Handwriting, page 1"]);
    expect(feed).not.toContain("手寫");
  });

  it("every page after the first loads lazily (the renderer lazy-loads every image)", () => {
    const [, second, third] = imgs(html);
    expect(second).toContain('loading="lazy"');
    expect(third).toContain('loading="lazy"');
  });

  it("a page is a full-width sheet by its mark; the user's own image with the same alt is not", () => {
    expect(imgs(html).every((i) => i.includes("md-image--ink-page"))).toBe(true);
    const own = renderToStaticMarkup(makeSiteMarkdown([note], { static: true })("![手寫第 1 頁](/api/media/mine.png)\n\n![a photo](/api/media/p.svg#ink-page-x)", "h"));
    expect(own).not.toContain("md-image--ink-page");
    const rule = /\.md-image--ink-page\s*\{([^}]*)\}/.exec(readFileSync(join(__dirname, "../components/MarkdownRenderer.css"), "utf8"))!;
    expect(rule[1]).toMatch(/width:\s*100%/);
    expect(rule[1]).toMatch(/margin:/);
    expect(readFileSync(join(__dirname, "../components/MarkdownRenderer.css"), "utf8")).not.toContain("手寫");
  });

  it("the app's renderer never reads the mark", () => {
    const app = renderToStaticMarkup(<MarkdownRenderer nodes={[]} onNavigate={() => {}}>{MARKDOWN}</MarkdownRenderer>);
    expect(app).not.toContain("md-image--ink-page");
  });
});

describe("the feed and the cover", () => {
  it("the feed carries the first page only", () => {
    const out = feedBodyHtml([note], note, "https://garden.example");
    expect(imgs(out)).toHaveLength(1);
    expect(out).toContain('src="https://garden.example/api/media/aaaa.svg#ink-page-1"');
    expect(out).not.toContain("bbbb.svg");
  });

  it("a sheet is not the note's summary either", () => {
    const only = handwritingPageMarkdown(1, "/api/media/aaaa.svg");
    expect(noteSummary(only, { title: "Lecture", maxLen: 200 })).toBe("");
    expect(noteSummary(MARKDOWN, { title: "Lecture", maxLen: 200 })).toBe("Notes in words.");
  });

  it("the article cover / share image is never a sheet of handwriting", () => {
    expect(coverImage(MARKDOWN)).toBeUndefined();
    expect(shareImageUrl(coverImage(`![a photo](/api/media/p.png)\n\n${MARKDOWN}`), "https://garden.example")).toBe("https://garden.example/api/media/p.png");
  });
});

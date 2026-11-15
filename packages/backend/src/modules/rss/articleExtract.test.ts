// 載入全文 article picking — pure, DB-free. One test per page kind in test/fixtures/rss-articles (what stays, what
// goes), plus the scanner, the never-shorter rule and hostile pages.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanElements, isMetaLine } from "./articleExtract.js";
import { extractArticleHtml } from "./sanitize.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/rss-articles/${name}.html`, import.meta.url)), "utf8");
const titleOf = (html: string) => /<title>([^<]*)/.exec(html)![1];
const extract = (name: string, opts: { title?: string; floorText?: string } = {}) => {
  const html = fixture(name);
  return extractArticleHtml(html, "https://blog.test/p/", { title: titleOf(html), ...opts });
};
const BODY1 = "Body paragraph one";
const BODY2 = "Body paragraph two";

describe("scanElements", () => {
  it("matches nested <div>s by balance, not by the first close tag", () => {
    const html = `<div id="a"><div id="b"><div id="c">x</div></div>tail</div>after`;
    const els = scanElements(html);
    const a = els.find((e) => e.attrs.includes('"a"'))!;
    expect(html.slice(a.innerStart, a.innerEnd)).toBe(`<div id="b"><div id="c">x</div></div>tail`);
  });
  it("ignores stray close tags, closes unclosed elements with their parent, keeps '>' inside quotes", () => {
    const html = `<div><p>one<p>two</span></div><a title="a > b" href=x>t</a>`;
    const els = scanElements(html);
    const div = els.find((e) => e.name === "div")!;
    expect(html.slice(div.innerStart, div.innerEnd)).toBe("<p>one<p>two</span>");
    expect(els.find((e) => e.name === "a")!.attrs).toContain('title="a > b"');
  });
  it("treats script bodies as text and never opens elements inside comments", () => {
    const els = scanElements(`<script>if (a<b) {document.write("<div>")}</script><!-- <p> --><i>x</i>`);
    expect(els.map((e) => e.name)).toEqual(["script", "i"]);
  });
});

describe("isMetaLine", () => {
  it("recognises date / reading-time / filed-under / byline lines and not sentences", () => {
    for (const t of ["published on 2026-11-01", "about 95 characters, 1 minute read", "Nov 1, 2026", "5 min read", "Posted in Uncategorized", "By Some Author", "發布於 2026-11-01", "約 3 分鐘閱讀"]) expect(isMetaLine(t), t).toBe(true);
    for (const t of ["By the way, this is a sentence about something else entirely.", "Body paragraph one", "We read for 5 hours and then the cat slept all afternoon on the sofa until it was dark."]) expect(isMetaLine(t), t).toBe(false);
  });
});

describe("extractArticleHtml — page kinds", () => {
  it("Hugo (reported page): body only — no title heading, header block, event banner, nav, share or footer; image and caption stay", () => {
    const out = extract("hugo-post-main");
    expect(out).toContain(BODY1); expect(out).toContain(BODY2);
    expect(out).toContain('src="https://blog.test/images/pic.jpg"');
    expect(out).toContain("<figcaption>Neutral caption line</figcaption>");
    expect(out).not.toMatch(/The Fixture Title|published on|categories|tags:|minute read|unrelated community event|Previous: other|Share|Copyright footer|<h1/);
  });
  it("Hugo (reported page) with the wider <main> pick still drops the title, header block and banner", () => {
    // A floor above the post body forces the wider pick: the drop rules must clean it on their own.
    const out = extract("hugo-post-main", { floorText: "x".repeat(400) });
    expect(out).toContain(BODY1);
    expect(out).not.toMatch(/The Fixture Title|published on|categories|minute read|unrelated community event|Previous: other|Copyright footer/);
  });
  it("Hugo PaperMod: drops header meta, table of contents, heading anchor, tags, prev/next and share", () => {
    const out = extract("hugo-papermod");
    expect(out).toContain(BODY1); expect(out).toContain("<h2 id=\"sec\">Section</h2>");
    expect(out).not.toMatch(/PaperMod Fixture|November 1|Table of Contents|#<|Share on X|Prev|Next|post-tags/);
  });
  it("Jekyll minima: takes the e-content block, not the header with title and byline", () => {
    const out = extract("jekyll-minima");
    expect(out).toContain(BODY1);
    expect(out).not.toMatch(/Minima Fixture|Nov 1, 2026|Some Author|Site footer/);
  });
  it("WordPress: entry-content only; sharing, related posts, comments, sidebar and caption markup handled", () => {
    const out = extract("wordpress-entry-content");
    expect(out).toContain(BODY1); expect(out).toContain(BODY2);
    expect(out).toContain("<figcaption>Neutral WP caption</figcaption>");
    expect(out).not.toMatch(/Share this|Related|Another related|thoughts|comment|Sidebar|Older post|Posted on|Posted in|WordPress Fixture/);
  });
  it("Ghost: gh-content only (no excerpt, byline, subscribe box); figcaption stays", () => {
    const out = extract("ghost-gh-content");
    expect(out).toContain(BODY1); expect(out).toContain("<figcaption>Neutral Ghost caption</figcaption>");
    expect(out).not.toMatch(/Ghost Fixture|neutral excerpt|1 min read|Subscribe|inbox|News/);
  });
  it("Medium-like (no usable classes): no title, byline, share buttons or 'more from'; figure and caption stay", () => {
    const out = extract("medium-like");
    expect(out).toContain(BODY1); expect(out).toContain("<figcaption>Neutral Medium caption</figcaption>");
    expect(out).not.toMatch(/Medium Fixture|Some Author|5 min read|Clap|Share|More from|Another story/);
  });
  it("Substack-like: body markup only; subscribe widget and like/share row go, captioned image stays", () => {
    const out = extract("substack-like");
    expect(out).toContain(BODY1); expect(out).toContain(BODY2);
    expect(out).toContain("<figcaption>Neutral Substack caption</figcaption>");
    expect(out).not.toMatch(/Subscribe|newsletter|Like|Share|Substack Fixture/);
  });
  it("Docusaurus/Astro (minified, unquoted attributes, unclosed <p>): header and hash-link gone, heading and caption stay", () => {
    const out = extract("docusaurus-astro-min");
    expect(out).toContain(BODY1); expect(out).toContain(BODY2);
    expect(out).toContain("Section");
    expect(out).not.toMatch(/Docs Fixture|hash-link|Direct link|Previous|Docs footer|table-of-contents/);
    expect(out).toContain('src="https://blog.test/assets/images/pic.png"');
    expect(out).toContain("<figcaption>Neutral minified caption</figcaption>");
  });
  it("Bear Blog: drops the lone date line under the title and the tag line; keeps the paragraphs", () => {
    const out = extract("bearblog");
    expect(out).toContain(BODY1); expect(out).toContain(BODY2);
    expect(out).not.toMatch(/Bear Fixture|01 Nov, 2026|blog\/tag|footer/);
  });
  it("a page with no semantic container: the paragraphs stay; title heading, posted-by line and top bar do not", () => {
    const out = extract("no-semantic-container");
    expect(out).toContain(BODY1); expect(out).toContain("Body paragraph three");
    expect(out).not.toMatch(/Plain Fixture|Posted by Some Author|<h2/);
  });
  it("end of article: previous/next, 'you may also like', the site's own link list and '» Home' go; external references and the caption stay", () => {
    const out = extract("hugo-post-tail");
    expect(out.replace(/<[^>]*>/g, "").trim()).toMatch(/External reference two$/);
    expect(out).toContain("Final body sentence");
    expect(out).toContain("<figcaption>Neutral caption under the image</figcaption>");
    expect(out).toContain("External reference one"); expect(out).toContain("References");
    expect(out).not.toMatch(/PREVIOUS POST|NEXT POST|你可能感興趣|Related post|&gt;&gt; Home|>> Home/);
    // the figure's caption sits right under the image
    expect(out).toMatch(/<img[^>]*><figcaption>Neutral caption under the image<\/figcaption>/);
  });
  it("end-of-article rule leaves a last real paragraph alone, and a list of links to other sites", () => {
    const page = `<article><p>${"Real closing paragraph. ".repeat(6)}</p><ul><li><a href="https://a.example/x">Source A</a></li><li><a href="https://b.example/y">Source B</a></li></ul></article>`;
    const out = extractArticleHtml(page, "https://blog.test/p/");
    expect(out).toContain("Real closing paragraph"); expect(out).toContain("Source B");
  });
  it("without a title nothing is guessed: the heading stays (links.ts passes the page title, tests without one keep it)", () => {
    const out = extractArticleHtml(fixture("no-semantic-container"), "https://blog.test/p/");
    expect(out).toContain("Plain Fixture");
  });
});

describe("extractArticleHtml — container choice", () => {
  const para = (n: string) => `<p>${n} ${"filler ".repeat(30)}</p>`;
  it("prefers the inner content container over the outer <article>", () => {
    const out = extractArticleHtml(`<body><article><div class="lede">teaser teaser teaser</div><div class="entry-content">${para("INNER")}</div></article></body>`);
    expect(out).toContain("INNER");
    expect(out).not.toContain("teaser");
  });
  it("a marker class on a small box inside the article does not replace the article", () => {
    const out = extractArticleHtml(`<body><article>${para("ONE")}${para("TWO")}${para("THREE")}<div class="prose"><p>callout</p></div></article></body>`);
    expect(out).toContain("THREE");
  });
  it("of rival containers keeps the one with the most paragraph text", () => {
    const out = extractArticleHtml(`<body><article>${para("SMALL")}</article><article>${para("BIG1")}${para("BIG2")}</article></body>`);
    expect(out).toContain("BIG2");
    expect(out).not.toContain("SMALL");
  });
  it("is never shorter than the feed's own text: falls back to the wider pick", () => {
    const page = `<body><main><p>Intro paragraph outside the content box, ${"wide ".repeat(40)}</p><div class="entry-content">${para("NARROW")}</div></main></body>`;
    const narrow = extractArticleHtml(page);
    expect(narrow).toContain("NARROW"); expect(narrow).not.toContain("Intro paragraph");
    const wide = extractArticleHtml(page, undefined, { floorText: "f".repeat(400) });
    expect(wide).toContain("NARROW"); expect(wide).toContain("Intro paragraph");
    // nothing wider on the page: the best there is, not an empty answer
    expect(extractArticleHtml(para("ONLY"), undefined, { floorText: "f".repeat(5000) })).toContain("ONLY");
  });
  it("keeps a picture-only article and unnamed wrappers; drops hidden and aria banner pieces", () => {
    expect(extractArticleHtml(`<article><img src="https://x.test/a.png"></article>`)).toContain("a.png");
    const out = extractArticleHtml(`<article>${para("KEEP")}<div role="complementary">side</div><div hidden>ghost</div></article>`);
    expect(out).toContain("KEEP"); expect(out).not.toMatch(/side|ghost/);
  });
  it("does not drop look-alike class names (share-your-story, banner-ad-free prose is kept when unrelated)", () => {
    const out = extractArticleHtml(`<article><div class="share-your-story">${para("STORY")}</div><div class="tags-are-fun">${para("FUN")}</div></article>`);
    expect(out).toContain("STORY"); expect(out).toContain("FUN");
  });
});

describe("extractArticleHtml — hostile pages", () => {
  const budgetMs = 3000;
  const timed = (fn: () => string) => { const t = performance.now(); const out = fn(); return { out, ms: performance.now() - t }; };
  it("unbalanced tags, unterminated quotes and comments", () => {
    const html = `<html><body><article><div><p>start${"<a href=\"x ".repeat(2000)}${"</span></div></p>".repeat(2000)}<!-- never closed ${"<script>".repeat(2000)}`;
    const { out, ms } = timed(() => extractArticleHtml(html));
    expect(typeof out).toBe("string"); expect(ms).toBeLessThan(budgetMs);
  });
  it("tens of thousands of nested divs", () => {
    const html = `<body><article>${"<div>".repeat(30000)}<p>${"deep text ".repeat(20)}</p>${"</div>".repeat(30000)}</article></body>`;
    const { out, ms } = timed(() => extractArticleHtml(html));
    expect(out).toContain("deep text"); expect(ms).toBeLessThan(budgetMs);
  });
  it("a 5 MB page of many small blocks", () => {
    const html = `<html><head><title>t</title></head><body><main>${"<div class=\"c\"><p>some paragraph text here</p><a href=\"/x\">link</a></div>\n".repeat(80000)}</main></body></html>`;
    expect(html.length).toBeGreaterThan(5_000_000);
    const { out, ms } = timed(() => extractArticleHtml(html, "https://x.test/", { title: "t", floorText: "x".repeat(100) }));
    expect(out).toContain("some paragraph text here"); expect(ms).toBeLessThan(budgetMs * 2);
  });
  it("a 5 MB page of unterminated quotes in tags", () => {
    const html = `<body>${"<a '\n".repeat(1_200_000)}</body>`;
    const { ms } = timed(() => extractArticleHtml(html));
    expect(ms).toBeLessThan(budgetMs * 2);
  });
});

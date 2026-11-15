import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { type MarkdownProfile, type WikilinkTarget } from "./index.js";
import { ondenMarkdown } from "./full.js";

function html(markdown: string, profile: MarkdownProfile = "published", wikilinkHref?: (l: WikilinkTarget) => string, math = true, footnoteLabels?: { heading: string; back: (n: number) => string }): string {
  const md = ondenMarkdown({ profile, wikilinkHref, math, footnoteLabels });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}

describe("ondenMarkdown", () => {
  it("words the footnote section's heading and back-links as asked, else in English", () => {
    const note = "Claim[^1]\n\n[^1]: Source";
    const zh = html(note, "app", undefined, true, { heading: "腳註", back: (n) => `回到內文第 ${n} 處` });
    expect(zh).toContain(">腳註</h2>");
    expect(zh).toContain('aria-label="回到內文第 1 處"');
    expect(html(note, "app")).toContain(">Footnotes</h2>");
  });

  it("app parses inline HTML and sanitizes it; published keeps it as text", () => {
    const md = 'Hi <kbd>there</kbd> <img src=x onerror="alert(1)"><script>alert(2)</script>';
    const app = html(md, "app");
    expect(app).toContain("<kbd>there</kbd>");
    expect(app).not.toContain("onerror");
    expect(app).not.toContain("<script");
    const published = html(md, "published");
    expect(published).toContain("&#x3C;kbd>there&#x3C;/kbd>");
    expect(published).not.toContain("<kbd>");
    expect(published).not.toContain("<script");
  });

  it("keeps only the pipeline's own classes on inline HTML", () => {
    const out = html('<div class="fixed inset-0 z-50 callout-note">x</div><span class="modal math-inline">y</span>', "app");
    expect(out).not.toMatch(/fixed|inset-0|z-50|modal/);
    expect(out).toContain('class="callout-note"');
  });

  it("bounds KaTeX sizes", () => {
    const out = html("$\\rule{500em}{500em}$");
    expect(out).toContain('class="katex"');
    expect(out).not.toMatch(/(width|height)[:=]\s*"?500em/); // the source in its annotation is fine
  });

  it("published parses only the tags Onden's editor writes, sanitized", () => {
    const out = html('Plain <u onclick="x()">under</u> and <mark>hi</mark>, but <kbd>K</kbd> <span class="callout">s</span>.\n\n<video controls src="https://cdn.example/a.mp4" onerror="x()"></video>\n\n<audio controls src="https://cdn.example/a.mp3"></audio>', "published");
    expect(out).toContain("<u>under</u>");
    expect(out).toContain("<mark>hi</mark>");
    expect(out).toContain('<video controls src="https://cdn.example/a.mp4"></video>');
    expect(out).toContain('<audio controls src="https://cdn.example/a.mp3"></audio>');
    expect(out).not.toMatch(/onclick|onerror/);
    expect(out).toContain("&#x3C;kbd>K&#x3C;/kbd>");
    expect(out).toContain("&#x3C;span");
    expect(html("<script>alert(1)</script> <u>x</u>", "published")).not.toContain("<script");
  });

  it("renders callouts with their type class and title", () => {
    for (const profile of ["app", "published"] as const) {
      const out = html("> [!warning] Careful\n> body", profile);
      expect(out).toContain('<div class="callout callout-warning">');
      expect(out).toContain('<p class="callout-title">Careful</p>');
      expect(out).toContain("<p>body</p>");
    }
    // Without a title of its own the marker names it.
    expect(html("> [!warning]\n> body")).toContain('<p class="callout-title">⚠️ WARNING</p>');
  });

  it("uses the title written after the marker, once, and keeps the body apart (Obsidian)", () => {
    const out = html("> [!tip] 我的標題\n> 內文第一行\n> 第二行");
    expect(out).toContain('<p class="callout-title">我的標題</p>');
    expect(out).not.toContain("💡 TIP");
    expect(out.match(/我的標題/g)).toHaveLength(1);
    expect(out).toContain("內文第一行");
    expect(html("> [!tip] **粗** 標題\n> x")).toContain('<p class="callout-title"><strong>粗</strong> 標題</p>');
    expect(html("> [!tip] Only a title")).toContain('<p class="callout-title">Only a title</p>');
  });

  it("folds with + (open) and - (closed) as a details element, in every profile", () => {
    for (const profile of ["app", "published"] as const) {
      const closed = html("> [!faq]- Why?\n> Because.", profile);
      expect(closed).toContain('<details class="callout callout-question">');
      expect(closed).not.toMatch(/<details[^>]* open/);
      expect(closed).toContain('<summary class="callout-title">Why?</summary>');
      expect(closed).toContain("Because.");
      const open = html("> [!faq]+ Why?\n> Because.", profile);
      expect(open).toMatch(/<details[^>]* open/);
      expect(open).toContain('<summary class="callout-title">Why?</summary>');
    }
    expect(html("> [!faq]-\n> Because.")).toContain('<summary class="callout-title">❓ FAQ</summary>');
    expect(html("> [!faq] Why?\n> Because.")).not.toContain("<details");
  });

  it("draws callout aliases as their Obsidian type, case-insensitively, and an unknown type as a note", () => {
    const classOf = (marker: string) => /<(?:div|details) class="callout (callout-[a-z]+)"/.exec(html(`> ${marker} T\n> body`))?.[1];
    const drawnAs: Record<string, string[]> = {
      note: ["note"], abstract: ["abstract", "summary", "tldr"], info: ["info"], todo: ["todo"],
      tip: ["tip", "hint", "important"], success: ["success", "check", "done"], question: ["question", "help", "faq"],
      warning: ["warning", "caution", "attention"], failure: ["failure", "fail", "missing"], danger: ["danger", "error"],
      bug: ["bug"], example: ["example"], quote: ["quote", "cite"],
    };
    for (const [type, names] of Object.entries(drawnAs)) {
      for (const name of names) expect(classOf(`[!${name}]`), name).toBe(`callout-${type}`);
    }
    expect(classOf("[!WARNING]")).toBe("callout-warning");
    expect(classOf("[!whatever]")).toBe("callout-note");
    expect(classOf("[!info]-")).toBe("callout-info");
    expect(html("> [!tldr]\n> body")).toContain('<p class="callout-title">📋 TLDR</p>');
  });

  it("renders math with KaTeX", () => {
    const out = html("Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x\\,dx\n$$");
    expect(out).toContain('class="katex"');
    expect(out).toContain('class="katex-display"');
  });

  it("with math off (text not written in Onden), dollar amounts stay text", () => {
    const out = html("Price $5 to $10 today", "app", undefined, false);
    expect(out).not.toContain("katex");
    expect(out).toContain("Price $5 to $10 today");
  });

  it("highlights code and keeps the language class", () => {
    const out = html("```js\nconst a = 1;\n```");
    expect(out).toContain('class="hljs language-js"');
    expect(out).toContain('<span class="hljs-keyword">const</span>');
  });

  it("drops javascript: links on every profile", () => {
    for (const profile of ["app", "published"] as const) {
      expect(html("[x](javascript:alert(1))", profile)).not.toContain("javascript:");
    }
  });

  it("points wikilinks where the renderer says, with block ids split off", () => {
    const seen: WikilinkTarget[] = [];
    const out = html("See [[Plan#^step-2|the step]] and [[Other]].", "published", (link) => {
      seen.push(link);
      return `/site/${link.target.toLowerCase()}/${link.blockId ? `#${link.blockId}` : ""}`;
    });
    expect(seen).toEqual([{ target: "Plan", blockId: "step-2", heading: null }, { target: "Other", blockId: null, heading: null }]);
    expect(out).toContain('href="/site/plan/#step-2"');
    expect(out).toContain(">the step</a>");
    const plain = html("[[Plan#^step-2]] and [[#^here]]", "published", (l) => (l.target ? `/site/${l.target}/` : "#"));
    expect(plain).toContain(">Plan</a>");
    expect(plain).toContain(">^here</a>");
    expect(html("See [[Other]].")).toContain("[[Other]]"); // no resolver: text
  });

  it("hides frontmatter and key:: value lines; a `^abc` in the text is just text", () => {
    const out = html("---\ntitle: T\n---\nBody line ^abc\n\nstatus:: done\n\nEnd");
    expect(out).not.toContain("title: T");
    expect(out).toContain("Body line ^abc");
    expect(out).not.toContain("data-block-id");
    expect(out).not.toContain("status::");
    expect(out).toContain("Body line");
  });

  it("keeps footnote links and back-links pointing at their targets", () => {
    const out = html("Claim[^1].\n\n[^1]: Source.");
    const hrefs = [...out.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) expect(out).toContain(`id="${href}"`);
    expect(out).not.toContain("user-content-user-content");
  });

  it("renders one newline as a line break", () => {
    expect(html("one\ntwo")).toContain("one<br>\ntwo");
  });
});

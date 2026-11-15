// What the sanitize schema does to a note's HTML, through the real pipeline (the
// schema's own test pins its shape; these pin what comes out). Each case names the
// attack or feature the allowlist entry exists for (sanitizeSchema.ts, mediaSanitize.ts).

import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { DOM_ID_PREFIX, sanitizeSchema } from "./sanitizeSchema.js";
import { mediaSanitizeAttributes, MEDIA_TAG_NAMES } from "./mediaSanitize.js";
import { ondenMarkdown } from "./full.js";

function render(markdown: string): string {
  const md = ondenMarkdown({ profile: "app", embeds: false, wikilinkHref: ({ target }) => `#wl:${target}` });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}

describe("raw HTML in a note", () => {
  it("drops script, style and event handlers but keeps the text", () => {
    const out = render('<script>alert(1)</script>\n\n<p onclick="x()" style="color:red">hi</p>\n\n<style>p{}</style>');
    expect(out).not.toMatch(/<script|<style|onclick|style=/i);
    expect(out).toContain("hi");
  });

  it("drops javascript: links", () => {
    expect(render('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
  });

  it("keeps the editor's own tags: underline and mark", () => {
    const out = render("an <u>under</u> and a <mark>mark</mark>");
    expect(out).toContain("<u>under</u>");
    expect(out).toContain("<mark>mark</mark>");
  });

  it("prefixes ids so a note cannot take the page's own DOM ids", () => {
    const out = render('<h2 id="root">x</h2>');
    expect(out).toContain(`id="${DOM_ID_PREFIX}root"`);
    expect(DOM_ID_PREFIX).toBe("user-content-");
  });
});

describe("media tags", () => {
  it("keeps a video with its player attributes and refuses a javascript: src", () => {
    const out = render('<video controls src="https://cdn.example/a.mp4" poster="https://cdn.example/p.png" onerror="x()"></video>');
    expect(out).toContain("<video");
    expect(out).toContain('src="https://cdn.example/a.mp4"');
    expect(out).toContain("controls");
    expect(out).toContain('poster="https://cdn.example/p.png"');
    expect(out).not.toContain("onerror");
    expect(render('<video src="javascript:alert(1)"></video>')).not.toMatch(/javascript:/i);
  });

  it("lets inline data: media through on src, but never on a link", () => {
    expect(render('<audio controls src="data:audio/mpeg;base64,AAAA"></audio>')).toContain('src="data:audio/mpeg;base64,AAAA"');
    expect(render('<a href="data:text/html,x">x</a>')).not.toContain("data:text/html");
  });

  it("keeps an iframe's sandbox and referrer policy attributes, which the default schema would strip", () => {
    const out = render('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" sandbox="allow-scripts" referrerpolicy="no-referrer" allowfullscreen></iframe>');
    expect(out).toContain("<iframe");
    expect(out).toContain('sandbox="allow-scripts"');
    expect(out).toMatch(/referrerpolicy="no-referrer"/i);
  });

  it("refuses an iframe whose src is not http(s) at the schema level", () => {
    expect(render('<iframe src="javascript:alert(1)"></iframe>')).not.toMatch(/javascript:/i);
  });
});

describe("classes come only from the allowlist", () => {
  it("drops a note's own css classes on span, div, p, code and a", () => {
    const out = render(
      '<span class="fixed inset-0 z-50">s</span><div class="fixed inset-0">d</div><p class="fixed">p</p><code class="fixed">c</code><a href="https://example.com" class="fixed">a</a>',
    );
    expect(out).not.toContain("fixed");
    expect(out).not.toContain("inset-0");
  });

  it("keeps the pipeline's own classes: math, callout, code language", () => {
    expect(render('<span class="math-x">m</span>')).toContain('class="math-x"');
    expect(render('<div class="callout callout-note">c</div>')).toContain('class="callout callout-note"');
    expect(render('<div class="callout-evil2">c</div>')).not.toContain("callout-evil2");
    expect(render('<p class="callout-title">t</p>')).toContain('class="callout-title"');
    expect(render('<code class="language-ts">c</code>')).toContain('class="language-ts"');
    expect(render('<code class="language-">c</code>')).not.toContain("language-");
    expect(render('<video class="md-video" src="https://cdn.example/a.mp4"></video>')).toContain('class="md-video"');
    expect(render('<video class="other" src="https://cdn.example/a.mp4"></video>')).not.toContain("other");
  });

  it("keeps a checked task checkbox", () => {
    expect(render("- [x] done")).toMatch(/<input[^>]*checked/);
    expect(render("- [ ] open")).not.toMatch(/<input[^>]*checked/);
  });
});

describe("the schema and the media allowlist", () => {
  it("lists the media tags in the schema, and only those plus the editor's tags beyond the default", () => {
    for (const tag of MEDIA_TAG_NAMES) expect(sanitizeSchema.tagNames).toContain(tag);
    expect(sanitizeSchema.tagNames).toEqual(expect.arrayContaining(["u", "mark"]));
  });

  it("merges the media attributes onto what the base already allows for those tags", () => {
    const merged = mediaSanitizeAttributes({ video: ["keep-me"], source: ["x"] });
    expect(merged.video?.[0]).toBe("keep-me");
    expect(merged.video).toContain("src");
    expect(merged.source).toEqual(["x", "src", "type"]);
    expect(merged.audio).toContain("controls");
    expect(merged.iframe).toContain("sandbox");
    expect(mediaSanitizeAttributes(null).iframe).toContain("sandbox");
    expect(mediaSanitizeAttributes(undefined).source).toEqual(["src", "type"]);
  });

  it("never allows a handler or style attribute on the media tags", () => {
    const merged = mediaSanitizeAttributes({});
    for (const [tag, attrs] of Object.entries(merged)) {
      for (const attr of attrs) {
        const name = Array.isArray(attr) ? String(attr[0]) : String(attr);
        expect(name, `${tag}[${name}]`).not.toMatch(/^on|^style$/i);
      }
    }
  });
});

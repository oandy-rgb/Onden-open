// What the PUBLISHED profile turns hostile note text into (the profile every public page, feed and static copy
// renders with). The review of 2026-11-11 (docs/archive/deep-review-publish-2026-11-11.md) wrote each vector
// of the usual XSS lists through the real pipeline and read the output as elements: an element that is not
// one the editor writes, an event handler, `style`, `srcdoc`, or a `javascript:` / `vbscript:` / `data:text`
// address in href, src or poster is a failure. Text that merely shows `<script>` as characters is fine
// (the profile prints raw HTML as text, so it arrives as `&#x3C;`).

import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { ondenMarkdown } from "./full.js";
import { isSafeLinkHref, urlScheme } from "./urlSchemes.js";

function render(markdown: string): string {
  const md = ondenMarkdown({ profile: "published", embeds: false, wikilinkHref: ({ target }) => `/site/${encodeURIComponent(target)}` });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}

/** Elements a published note can legitimately produce (the editor's, the renderer's, math and code highlighting). */
const ALLOWED_TAGS = new Set([
  "p", "a", "img", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "em", "strong", "del", "hr", "br",
  "table", "thead", "tbody", "tr", "th", "td", "input", "u", "mark", "audio", "video", "source", "span", "div", "details", "summary",
  "section", "sup", "sub", "math", "semantics", "mrow", "mstyle", "mtext", "annotation", "mi", "mo", "mn", "msup", "msub", "mfrac", "msqrt", "mspace", "svg", "path", "line",
]);

const MATH_STYLE_TAGS = new Set(["span", "math", "mstyle", "mspace", "mtext", "mi", "mo", "mn", "mrow", "svg", "path", "line"]);

type Tag = { name: string; attrs: Array<[string, string]> };
/** Every real element in `html` (a `<` of text is written `&#x3C;`, so a `<` here starts a tag). */
function tagsOf(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g)) {
    const attrs: Array<[string, string]> = [];
    for (const a of m[2]!.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs.push([a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""]);
    tags.push({ name: m[1]!.toLowerCase(), attrs });
  }
  return tags;
}

function assertInert(markdown: string): void {
  const html = render(markdown);
  for (const { name, attrs } of tagsOf(html)) {
    expect(ALLOWED_TAGS.has(name), `${JSON.stringify(markdown)} → element <${name}>`).toBe(true);
    for (const [attr, value] of attrs) {
      expect(attr.startsWith("on"), `${JSON.stringify(markdown)} → ${attr}`).toBe(false);
      expect(["srcdoc", "formaction", "action", "xlink:href"]).not.toContain(attr);
      // `style` is KaTeX's own (math layout) and nothing else's; its value must carry no address or script.
      if (attr === "style") {
        expect(MATH_STYLE_TAGS.has(name), `${JSON.stringify(markdown)} → style on <${name}>`).toBe(true);
        expect(value).not.toMatch(/url\(|expression|javascript|@import|</i);
      }
      if (attr === "href") expect(isSafeLinkHref(value), `${JSON.stringify(markdown)} → href ${value}`).toBe(true);
      if (attr === "src" || attr === "poster") {
        const scheme = urlScheme(value);
        // data: only for inline images / audio / video (an <img> or media element never runs script); never text/html.
        if (scheme === "data") expect(value).toMatch(/^data:(?:image|audio|video)\//i);
        else expect(scheme === undefined || scheme === "http" || scheme === "https", `${JSON.stringify(markdown)} → ${attr} ${value}`).toBe(true);
      }
    }
  }
}

const VECTORS = [
  "[x](javascript:alert(1))", "[x](java&#9;script:alert(1))", "[x](&#106;avascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x]( javascript:alert(1))",
  "[x](<javascript:alert(1)>)", "[x][r]\n\n[r]: javascript:alert(1)", "<javascript:alert(1)>", "[x](vbscript:msgbox(1))", "[x](data:text/html,<script>alert(1)</script>)",
  "![x](javascript:alert(1))", "![x](data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==)",
  '<video src="data:text/html,<script>alert(1)</script>" poster="javascript:1" onerror="x"></video>',
  '<video><source src="javascript:alert(1)" onerror="x"></video>', '<audio src="vbscript:x" autoplay onloadstart="x()"></audio>',
  '<video controls style="position:fixed" class="fixed inset-0" id="app"></video>', '<u onmouseover="x()">a</u><mark style="x">b</mark>',
  '<iframe src="https://evil.example"></iframe>', '<iframe srcdoc="<script>1</script>"></iframe>', "<img src=x onerror=alert(1)>", "<svg onload=alert(1)>",
  '<a href="javascript:1">x</a>', "<math><mtext></p><img src=x onerror=1>", '<video src=https://a.b/x.mp4 srcdoc="<script>1</script>"></video>',
  "<details open ontoggle=alert(1)><summary>x</summary></details>", "<object data=x></object><embed src=x><form action=x><button formaction=y>",
  "<base href=//evil.example/><link rel=stylesheet href=//evil.example/x.css><meta http-equiv=refresh content='0;url=//evil.example'>",
  "[[a|<img src=x onerror=1>]]", '[[x"onmouseover="alert(1)]]', "[[javascript:alert(1)]]", "[[a#<script>alert(1)</script>]]",
  "```\n<script>1</script>\n```", "`<img src=x onerror=1>`", "$$\\href{javascript:alert(1)}{x}$$", "$\\url{javascript:alert(1)}$", "$$\\htmlClass{a}{x}$$", "$\\includegraphics{x}$",
  "$\\htmlStyle{color:red}{x}$", "$\\htmlData{a=b}{x}$", "$\\htmlId{app}{x}$", "- [x] <u>t</u>\n- [ ] [l](javascript:1)", "| a |\n|---|\n| <img src=x onerror=1> |",
  "[^1]\n\n[^1]: [x](javascript:1)", "> [!note] <script>1</script>\n> body", "# <img src=x onerror=1>", "<!-- --><script>alert(1)</script>",
  "&lt;script&gt;alert(1)&lt;/script&gt;", "<a href=\"&#x6A;avascript:alert(1)\">x</a>", "<audio src=//evil.example/x.mp3></audio>",
];

describe("the published profile: hostile note text comes out inert", () => {
  it.each(VECTORS.map((v) => [v]))("%j", (markdown) => assertInert(markdown));

  it("the vectors really are read as elements: a harmless allowed element is found by the checker", () => {
    expect(tagsOf(render("a <u>b</u> [c](https://example.com)")).map((t) => t.name)).toEqual(["p", "u", "a"]);
    expect(tagsOf(render('<iframe src="https://evil.example"></iframe>')).map((t) => t.name)).toEqual([]);
  });

  // An <img> never runs what its src holds, and browsers refuse a top-level data:text/html navigation, so this is
  // not script execution: it is the documented rule ("never data:text/html", urlSchemes.ts SAFE_DATA_MEDIA_SRC)
  // not holding in the markdown pipeline that the exports and the static copy use. Fix direction: a rehype step
  // (or schema `protocols.src` + a per-tag check like mediaEmbed's iframe gate) dropping an img src whose
  // data: type is not image/*, audio/*, video/*.
  it("an image address of data:text/html is dropped, as the schema's own comment says", () => {
    assertInert("![x](data:text/html,<script>alert(1)</script>)");
  });

  it("a note cannot take a DOM id of the page (the sanitizer prefixes ids)", () => {
    const ids = tagsOf(render('<video id="app" controls></video>\n\n# Root')).flatMap((t) => t.attrs.filter(([a]) => a === "id").map(([, v]) => v));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith("user-content-")).toBe(true);
  });
});

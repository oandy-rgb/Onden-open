// ⑩ custom appearance — owner CSS on the published site (the Notion-can't-do
// win). Two guarantees pinned here: (1) the sanitiser can't be escaped out of
// the <style> block, and (2) buildNoteExportCss appends the owner CSS LAST so
// its rules override the generated theme.
import { describe, it, expect } from "vitest";
import { sanitizeSiteCss, SITE_CSS_MAX } from "@onden/site";
import { buildNoteExportCss } from "../modules/website/publishing/css.js";
import { buildSingleNoteHtml } from "../modules/website/publishing/singleNoteHtml.js";

describe("sanitizeSiteCss", () => {
  it("drops @import however it is written: the published site makes no third-party request", () => {
    for (const css of ['@import url("https://x/y.css");a{}', "@IMPORT 'x.css';a{}", "@im\\70ort 'x.css';a{}", "@\\69mport 'x.css';a{}"]) {
      expect(sanitizeSiteCss(css).toLowerCase(), css).not.toContain("import");
      expect(sanitizeSiteCss(css), css).not.toContain("@\\");
    }
    expect(sanitizeSiteCss("a{}")).toBe("a{}");
  });

  it("drops an @import that a single removal would have rebuilt from the text around it", () => {
    for (const css of ["@i@import;mport url(https://x/y.css);a{}", "@@import;import url(x);a{}", "@\\@import;import url(x);a{}"]) {
      expect(sanitizeSiteCss(css).toLowerCase(), css).not.toContain("@import");
      expect(sanitizeSiteCss(css), css).not.toMatch(/@\s*\\/);
    }
  });

  it("passes ordinary CSS through unchanged", () => {
    const css = ".site-root{--site-accent:#b3402f}\n.published-h1{letter-spacing:-.02em}";
    expect(sanitizeSiteCss(css)).toBe(css);
  });

  it("neutralises </style> so it can't break out of the style block", () => {
    const evil = "a{}</style><script>alert(1)</script>";
    const out = sanitizeSiteCss(evil);
    expect(out).not.toMatch(/<\/style/i);
    // the script tag text may remain but is inert inside a <style> raw-text node
    // (only </style closes it) — what matters is the closer is gone
    expect(out.includes("</style>")).toBe(false);
  });

  it("is case-insensitive about the closing tag", () => {
    expect(sanitizeSiteCss("x{}</STYLE >")).not.toMatch(/<\/style/i);
  });

  // GAP-244: single-pass removal of `</style` rebuilt the closer from a nested
  // payload. No literal `<` may survive, whatever the nesting.
  it("cannot be rebuilt from a nested closer", () => {
    for (const evil of [
      "a{}</sty</stylele><script>x</script>",
      "a{}<</style/style><script>x</script>",
      "a{}</s</</stylestyletyle>",
    ]) {
      const out = sanitizeSiteCss(evil);
      expect(out).not.toContain("<");
      expect(out).not.toMatch(/<\/style/i);
    }
  });

  it("keeps a `<` inside CSS strings meaningful (as the \\3c escape)", () => {
    expect(sanitizeSiteCss('.a::before{content:"<"}')).toBe('.a::before{content:"\\3c "}');
  });

  it("caps length and tolerates empty/nullish", () => {
    expect(sanitizeSiteCss(undefined)).toBe("");
    expect(sanitizeSiteCss(null)).toBe("");
    expect(sanitizeSiteCss("")).toBe("");
    expect(sanitizeSiteCss("a".repeat(SITE_CSS_MAX + 500)).length).toBe(SITE_CSS_MAX);
  });
});

describe("buildNoteExportCss custom-CSS injection", () => {
  it("appends owner CSS after the base rules so it wins the cascade", () => {
    const out = buildNoteExportCss({ template: "clean-docs", tokens: { accent: "#123456" },
      custom_css: ".published-h1{color:hotpink}" });
    expect(out).toContain("Custom CSS (site owner)");
    expect(out).toContain(".published-h1{color:hotpink}");
    // it comes after the generated tokens block (later = higher precedence)
    expect(out.indexOf(".published-h1{color:hotpink}")).toBeGreaterThan(out.indexOf("--accent"));
  });

  it("omits the custom block entirely when there's no custom CSS", () => {
    const out = buildNoteExportCss({ template: "clean-docs", tokens: {} });
    expect(out).not.toContain("Custom CSS (site owner)");
  });

  it("⑩ paper tone overrides --bg/--sur AFTER the theme (only for a valid hex)", () => {
    const out = buildNoteExportCss({ template: "clean-docs", tokens: {}, site_bg: "#f5f1e8" });
    expect(out).toContain("Paper tone (site owner)");
    expect(out).toContain("--bg:#f5f1e8");
    expect(out).toContain("--sur:#f5f1e8");
    // wins the cascade: comes after the template's own --bg
    expect(out.lastIndexOf("--bg:#f5f1e8")).toBeGreaterThan(out.indexOf("--bg:"));
  });

  it("⑩ paper tone: empty / non-hex is ignored (zero regression)", () => {
    // Older sites saved #rgb and #rrggbbaa; they still apply, written in full.
    expect(buildNoteExportCss({ tokens: {}, site_bg: "#fff" })).toContain("--bg:#ffffff;--sur:#ffffff");
    expect(buildNoteExportCss({ tokens: {}, site_bg: " #F5F1E8CC " })).toContain("--bg:#f5f1e8cc");
    expect(buildNoteExportCss({ tokens: {}, site_bg: "#ff" })).not.toContain("Paper tone");
    expect(buildNoteExportCss({ tokens: {}, site_bg: "" })).not.toContain("Paper tone");
    expect(buildNoteExportCss({ tokens: {}, site_bg: "red; } body{}" })).not.toContain("Paper tone");
  });

  it("sanitises injected CSS (no </style escape in the output)", () => {
    const out = buildNoteExportCss({ tokens: {}, custom_css: "a{}</style><script>x" });
    expect(out).not.toMatch(/<\/style/i);
  });
});

describe("buildNoteExportCss — settled Onden type system (Fraunces × Plex)", () => {
  it("applies the vendored type-system STACKS in the DEFAULT export (no owner font)", () => {
    const out = buildNoteExportCss({ template: "personal-blog", tokens: {} });
    // The Fraunces × Plex family STACKS reach the export (the bug: it fell to
    // Georgia). The names appear inside the font-family vars/declarations.
    expect(out).toContain("Fraunces");
    expect(out).toContain("IBM Plex Sans");
    expect(out).toContain("IBM Plex Mono");
    // Type-system vars exist and the body resolves to the Plex sans stack.
    expect(out).toContain("--font-display:");
    expect(out).toContain("--font-body:");
    expect(out).toMatch(/font-family:"IBM Plex Sans"/);
  });

  // ── Security: a published site must NOT phone home by default ──
  // RED-AUDIT published-css-egress. The default CSS leaked visitor IPs to
  // Google Fonts (@import) and jsdelivr (KaTeX @font-face). External web fonts
  // are now opt-in only.
  it("DEFAULT export emits NO external font request (no Google Fonts, no jsdelivr)", () => {
    const out = buildNoteExportCss({ template: "personal-blog", tokens: {} });
    expect(out).not.toContain("fonts.googleapis.com");
    expect(out).not.toContain("cdn.jsdelivr.net");
    expect(out).not.toContain("@import");
    // …and no leftover @font-face url() pointing at any http(s) origin.
    expect(out).not.toMatch(/@font-face[^}]*url\(\s*['"]?https?:/i);
  });

  it("the same holds with math present in the document (KaTeX block, default)", () => {
    // The KaTeX block is always inlined; verify its glyph fonts don't leak.
    const out = buildNoteExportCss({ template: "clean-docs", tokens: {} });
    expect(out).toContain("KaTeX (math)");
    expect(out).not.toContain("cdn.jsdelivr.net");
  });

  it("owner can OPT IN to web fonts via tokens.webfonts → @import returns, first", () => {
    const out = buildNoteExportCss({ template: "clean-docs", tokens: { webfonts: true } });
    expect(out).toContain("fonts.googleapis.com/css2");
    // @import must precede any rule; nothing (not even the reset) before it.
    expect(out.trimStart().startsWith("@import")).toBe(true);
    expect(out.indexOf("@import")).toBeLessThan(out.indexOf("*{box-sizing"));
    // opting in also restores the KaTeX CDN glyphs.
    expect(out).toContain("cdn.jsdelivr.net");
  });

  it("headings use the Fraunces display stack, not Georgia", () => {
    const out = buildNoteExportCss({ template: "personal-blog", tokens: {} });
    // The hardcoded Georgia brand/heading rules are gone in the default case.
    expect(out).not.toContain("font-family:Georgia,serif");
    expect(out).toContain("var(--font-display)");
  });

  it("the owner-chosen font still WINS (no Onden override, no CDN import)", () => {
    const out = buildNoteExportCss({
      template: "personal-blog",
      tokens: { font: "Comic Sans MS, cursive" },
    });
    expect(out).toContain("font-family:Comic Sans MS, cursive");
    // Owner opted out of the default → don't pull the Onden fonts off the CDN.
    expect(out).not.toContain("fonts.googleapis.com/css2");
  });
});

describe("buildSingleNoteHtml — ⑩ styled single-note export", () => {
  const note = { title: "My Note", slug: "my-note", markdown: "# My Note\n\nHello **world**." };

  it("is a self-contained HTML doc: inline theme CSS, the body, no site nav chrome", () => {
    const html = buildSingleNoteHtml(note, { template: "clean-docs", tokens: { accent: "#abcdef" } });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");          // CSS is inlined (no external link)
    expect(html).toContain("#abcdef");          // theme accent flows through
    expect(html).toContain("Hello <strong>world</strong>"); // rendered markdown
    expect(html).toContain('class="markdown-body"');
    expect(html).not.toContain('class="site-nav"');         // no nav/site chrome
    expect(html).toContain('class="site-root');             // owner .site-root CSS applies
  });

  it("carries the owner custom CSS (so an export matches the published look)", () => {
    const html = buildSingleNoteHtml(note, { tokens: {}, custom_css: ".site-root{--site-accent:hotpink}" });
    expect(html).toContain(".site-root{--site-accent:hotpink}");
  });

  it("escapes the title and survives a </style smuggle in custom CSS", () => {
    const html = buildSingleNoteHtml(
      { title: "A <b>x</b>", markdown: "body" },
      { tokens: {}, custom_css: "a{}</style><script>x" },
    );
    expect(html).toContain("A &lt;b&gt;x&lt;/b&gt;"); // title escaped in <title> + <h1>
    expect(html).not.toContain("</style><script>x");  // smuggle neutralised
  });

  it("survives the nested </sty</stylele> smuggle (GAP-244)", () => {
    const html = buildSingleNoteHtml(
      { title: "t", markdown: "body" },
      { tokens: {}, custom_css: "a{}</sty</stylele><script>window.__x=1</script>" },
    );
    expect(html).not.toContain("<script>window.__x=1");
    // exactly one <style> element, closed exactly once
    expect(html.match(/<\/style>/gi)?.length).toBe(1);
  });
});

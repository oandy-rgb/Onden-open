// LaTeX/math must render on the PUBLISHED static site the same way it does
// in-app. Before this fix, the publish pipeline's md2html had no remark-math /
// rehype-katex step (and buildPublishedCss shipped no KaTeX stylesheet), so a
// note with `$...$` looked right in the editor but shipped as raw dollar text
// on the site. These tests pin both halves of the fix: md2html renders KaTeX
// HTML, and the published CSS carries the KaTeX styles.

import { describe, it, expect } from "vitest";
import { md2html } from "../modules/website/publishing/index.js";
import { buildNoteExportCss, buildKatexCss } from "../modules/website/publishing/css.js";
import { buildSingleNoteHtml } from "../modules/website/publishing/singleNoteHtml.js";
import type { Manifest } from "../modules/website/publishing/types.js";

describe("published-site math rendering", () => {
  it("renders inline $...$ to KaTeX HTML", () => {
    const out = md2html("Pythagoras: $a^2+b^2=c^2$ done.");
    expect(out).toContain('class="katex"');
    // The original markdown text should NOT survive as a raw dollar run.
    expect(out).not.toContain("$a^2+b^2=c^2$");
  });

  it("renders block $$...$$ in display mode", () => {
    const out = md2html("$$\n\\frac{x}{y}\n$$");
    expect(out).toContain('class="katex"');
    expect(out).toContain("katex-display");
  });

  it("$$...$$ inside a line is inline math (remark-math, as in the app since W38c)", () => {
    const out = md2html("so $$\\frac{x}{y}$$ here");
    expect(out).toContain('class="katex"');
    expect(out).not.toContain("katex-display");
  });

  it("leaves dollar signs inside code spans/blocks untouched", () => {
    const inline = md2html("price `costs $5 and $6` here");
    expect(inline).toContain("$5 and $6");
    expect(inline).not.toContain('class="katex"');

    const fenced = md2html("```\nliteral $z$ stays\n```");
    expect(fenced.replace(/<[^>]+>/g, "")).toContain("$z$"); // highlighting may split it into spans
    expect(fenced).not.toContain('class="katex"');
  });

  it("degrades malformed math to a KaTeX error instead of throwing", () => {
    expect(() => md2html("$\\frac{$")).not.toThrow();
  });

  it("buildKatexCss DEFAULT ships the layout rules but NO @font-face egress", () => {
    const css = buildKatexCss();
    // Layout/positioning + the .katex font-family rules survive…
    expect(css).toContain("KaTeX_Main");
    // …but the @font-face blocks (the only thing carrying network URLs) are
    // stripped so a published site makes no third-party font request.
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("cdn.jsdelivr.net");
    expect(css).not.toMatch(/url\(fonts\//);
  });

  it("buildKatexCss({webfonts:true}) opts in to the pinned CDN glyphs", () => {
    const css = buildKatexCss({ webfonts: true });
    expect(css).toContain("KaTeX_Main");
    // @font-face URLs rewritten away from the bundle-relative `fonts/` path
    // (absent in the static export) to the pinned CDN.
    expect(css).toContain("cdn.jsdelivr.net/npm/katex@");
    expect(css).not.toMatch(/url\(fonts\//);
  });

  it("buildNoteExportCss includes the KaTeX styles", () => {
    const css = buildNoteExportCss({} as Manifest);
    expect(css).toContain("KaTeX_Main");
  });

  it("single-note export ships both the KaTeX markup and styles", () => {
    const html = buildSingleNoteHtml(
      { title: "Math note", markdown: "Euler: $e^{i\\pi}+1=0$" },
      {} as Manifest,
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain("KaTeX_Main");
  });
});

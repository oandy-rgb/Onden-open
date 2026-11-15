// static-export LaTeX — the single-note HTML export must KEEP math, not
// drop it. Round 1's latex fix only touched the live SPA renderer; this is the
// separate server-side md2html → static-builder path academics need for the
// archival artifact. Guards: (1) md2html renders $…$ / $$…$$ to KaTeX markup,
// (2) the export head ships KaTeX CSS so the math is actually styled.
import { describe, it, expect } from "vitest";
import { md2html } from "../modules/website/publishing/index.js";
import { buildSingleNoteHtml } from "../modules/website/publishing/singleNoteHtml.js";
import { buildNoteExportCss } from "../modules/website/publishing/css.js";

describe("md2html — LaTeX math in the static export pipeline", () => {
  it("renders inline $…$ to KaTeX markup (not dropped as plain text)", () => {
    const out = md2html("Energy is $E=mc^2$ today.");
    expect(out).toContain('class="katex"');
    // the raw `$E=mc^2$` source must not survive verbatim
    expect(out).not.toContain("$E=mc^2$");
  });

  it("renders block $$…$$ display math", () => {
    // display math = $$ on its own block (remark-math treats a single-line
    // $$x$$ as inline; a standalone block is the display form).
    const out = md2html("$$\n\\int_0^1 x\\,dx\n$$");
    expect(out).toContain("katex");
    expect(out).toContain("katex-display");
  });

  it("leaves ordinary markdown (and prices like $5) untouched", () => {
    const out = md2html("Buy for **$5** off.");
    expect(out).toContain("<strong>$5</strong>");
  });

  it("survives sanitize: KaTeX output is preserved, not stripped", () => {
    const out = md2html("$\\frac{a}{b}$");
    // KaTeX emits <span> structure with class names — the sanitizer (which runs
    // BEFORE rehypeKatex) must not strip these.
    expect(out).toMatch(/<span class="katex"/);
  });
});

describe("static export heads ship KaTeX CSS (so math is styled, not unstyled)", () => {
  it("buildNoteExportCss inlines the KaTeX stylesheet", () => {
    const css = buildNoteExportCss({ template: "clean-docs", tokens: {} });
    // Round-1 inlines the real katex.min.css (read from the installed package),
    // labelled "KaTeX (math)" — assert on the stylesheet's own selectors, which
    // are the load-bearing signal that math will actually be styled.
    expect(css).toContain(".katex");
  });

  it("buildSingleNoteHtml renders math AND carries KaTeX CSS in its <style>", () => {
    const html = buildSingleNoteHtml(
      { title: "Paper", slug: "paper", markdown: "Result: $a^2 + b^2 = c^2$." },
      { template: "clean-docs", tokens: {} },
    );
    expect(html).toContain('class="katex"'); // math rendered into the body
    expect(html).toContain(".katex");          // KaTeX CSS inlined in <style>
  });
});

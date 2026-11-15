// Published-artifact CSP — the second XSS belt behind rehype-sanitize.
//
// Published HTML ships to GitHub Pages (no response headers possible), so the
// policy travels as a <meta http-equiv> tag baked into every artifact:
// the single-note export allows NO script source at all; the static copy's
// pages allow 'self' modules, their own inline scripts by hash and exactly the
// analytics host the owner opted into — never 'unsafe-inline'.
// These tests pin (a) the policy builder's shape, (b) that every output
// actually embeds it, and (c) that the script hashes match the emitted scripts.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { publishedCspContent, publishedCspMetaTag, ga4InlineScript } from "../modules/website/publishing/htmlUtils.js";
import { buildSingleNoteHtml } from "../modules/website/publishing/singleNoteHtml.js";
import { withCsp } from "../modules/website/publishing/staticSite.js";

// A page as the SSR server renders it: the head carries the ga4 bootstrap (siteHead),
// the body a few lines of the copy-button script.
const page = (analytics?: { id: string }): string =>
  `<!DOCTYPE html><html><head><meta charset="UTF-8" />${analytics ? `<script>${ga4InlineScript(analytics.id)}</script>` : ""}</head>` +
  `<body><script type="module">document.documentElement.classList.add("s-js");</script><script type="module" src="../_astro/x.js"></script></body></html>`;

describe("publishedCspContent", () => {
  it("static variant allows no script source at all", () => {
    const csp = publishedCspContent({ variant: "static" });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("spa variant allows only 'self' scripts when no analytics is configured", () => {
    const csp = publishedCspContent({ variant: "spa" });
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).not.toContain("googletagmanager");
    expect(csp).not.toContain("plausible");
  });

  it("frame-src mirrors the trusted embed hosts and nothing else", () => {
    const csp = publishedCspContent({ variant: "static" });
    const frame = csp.split("; ").find((d) => d.startsWith("frame-src "))!;
    for (const h of ["youtube.com", "youtube-nocookie.com", "player.vimeo.com", "vimeo.com"]) {
      expect(frame).toContain(`https://${h}`);
      expect(frame).toContain(`https://*.${h}`);
    }
    expect(frame).not.toContain("http://");
  });

  it("analytics providers widen script/connect to their host only", () => {
    const plausible = publishedCspContent({ variant: "spa", analytics: { provider: "plausible", id: "x.com" } });
    expect(plausible).toContain("script-src 'self' 'wasm-unsafe-eval' https://plausible.io");
    expect(plausible).toContain("connect-src 'self' https://plausible.io");
    expect(plausible).not.toContain("umami");

    const umami = publishedCspContent({ variant: "spa", analytics: { provider: "umami", id: "abc" } });
    expect(umami).toContain("https://cloud.umami.is");
    expect(umami).not.toContain("plausible");
  });

  it("ga4 allows the inline bootstrap by hash, never 'unsafe-inline'", () => {
    const id = "G-TEST123";
    const csp = publishedCspContent({ variant: "spa", analytics: { provider: "ga4", id } });
    const expected = createHash("sha256").update(ga4InlineScript(id)).digest("base64");
    expect(csp).toContain(`'sha256-${expected}'`);
    expect(csp).toContain("https://www.googletagmanager.com");
    // style-src legitimately carries 'unsafe-inline' (inline <style>); the
    // script directive must not.
    const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script).not.toContain("unsafe-inline");
  });

  it("webfonts opt-in adds Google Fonts + the KaTeX CDN; default stays closed", () => {
    const on = publishedCspContent({ variant: "static", webfonts: true });
    expect(on).toContain("https://fonts.googleapis.com");
    expect(on).toContain("https://fonts.gstatic.com");
    expect(on).toContain("https://cdn.jsdelivr.net");
    const off = publishedCspContent({ variant: "static" });
    expect(off).not.toContain("fonts.googleapis.com");
    expect(off).not.toContain("jsdelivr");
  });
});

describe("CSP lands in every published artifact", () => {
  it("single-note export embeds the static policy", () => {
    const html = buildSingleNoteHtml({ title: "N", markdown: "hi" }, {} as never);
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
    expect(html).toContain("script-src 'none'");
  });

  it("a static-copy page embeds the policy, before any script", () => {
    const html = withCsp(page(), undefined);
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-");
  });

  it("the copy's policy allows the configured analytics host", () => {
    const html = withCsp(page(), { provider: "plausible", id: "x.com" });
    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval' https://plausible.io");
  });

  it("ga4 with an id that is not a measurement id allows no inline script and no gtag host", () => {
    const csp = publishedCspContent({ variant: "spa", analytics: { provider: "ga4", id: 'G-1");alert(1);//' } });
    expect(csp).not.toContain("sha256-");
    expect(csp).not.toContain("googletagmanager");
  });

  it("a page's CSP hashes match the inline scripts it carries (ga4 bootstrap and the copy button)", () => {
    const id = "G-ABC999";
    const html = withCsp(page({ id }), { provider: "ga4", id });
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([^<]*)<\/script>/g)].map((m) => m[1]);
    expect(inline.some((t) => t.includes("dataLayer"))).toBe(true);
    for (const text of inline) {
      expect(html).toContain(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
    }
  });
});

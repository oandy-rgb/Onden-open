// Fuzz: what the exports and the published site emit from untrusted text:
// md2html (the published-profile pipeline plus the export element rewrite),
// safeUrl, and the owner's custom CSS. Invariants: never throws, bounded
// time, the sanitized HTML has no script / handler / javascript: or non-media
// data: URL / style / base / meta / form, an <iframe> only on the embed
// allowlist, a custom stylesheet cannot close its <style>.
// Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import type { Element, Root } from "hast";
import { md2html, safeUrl } from "../modules/website/publishing/htmlUtils.js";
import { sanitizeSiteCss, SITE_CSS_MAX } from "@onden/site";
import { anyString, expectWithinBudget, fuzzParams, hostileInput, soup } from "./fuzzSupport.js";
import { htmlHazards } from "../../../markdown/src/test/htmlHazards.js";

// The Markdown package's corpus: one hostile-seed list for the pipeline and for what ships it.
const corpus = JSON.parse(readFileSync(new URL("../../../markdown/src/test/fuzz-corpus/markdown.json", import.meta.url), "utf8")) as Record<string, string>;

// Findings of the Markdown pipeline fuzz (packages/markdown/src/test/markdownPipeline.fuzz.test.ts) that reach the
// export too: data: URLs of any media type on src, and the poster of a <video>. Dropped from the report here so the
// rest stays checked; the finding cases live in the markdown package.
const KNOWN_HAZARD = /non-media data: URL$|^<video> poster javascript: URL$/;
const hazards = (html: string) => htmlHazards(html, "embed-allowlist").filter((h) => !KNOWN_HAZARD.test(h));

const pages = [
  { id: "p1", title: "Alpha", slug: "alpha", markdown: "# H\n\ntext" },
  { id: "p2", title: "<script>x</script>", slug: "beta", aliases: ["javascript:x"] },
];

describe("md2html fuzz", () => {
  it("corpus seeds: never throw, stay in budget, output sanitized", () => {
    for (const [name, md] of Object.entries(corpus)) {
      let html = "";
      expectWithinBudget(name, md, 400, () => { html = md2html(md, { pages, from: "p1" }); });
      expect(hazards(html), name).toEqual([]);
    }
  });

  it("random and mutated Markdown, with and without a site: sanitized, in budget", () => {
    fc.assert(fc.property(hostileInput(corpus), fc.boolean(), fc.boolean(), (md, withSite, relative) => {
      let html = "";
      expectWithinBudget("md2html", md, 400, () => { html = md2html(md, withSite ? { pages, from: "p1", relative } : undefined); });
      expect(hazards(html)).toEqual([]);
    }), fuzzParams(100));
  });

  it("a note about an embed becomes a frame only for a trusted provider", () => {
    const host = fc.constantFrom("www.youtube.com", "youtu.be", "vimeo.com", "player.vimeo.com", "notyoutube.com", "youtube.com.evil.example", "evil.example", "www.youtube.com@evil.example", "evilvimeo.com");
    const path = fc.constantFrom("/watch?v=abcdefghijk", "/embed/abcdefghijk", "/abcdefghijk", "/123456", "/video/123456", "/");
    fc.assert(fc.property(host, path, fc.constantFrom("![x](URL)", "[URL](URL)", "URL", "<URL>", "![[URL]]"), (h, p, shape) => {
      const url = `https://${h}${p}`;
      const html = md2html(shape.replaceAll("URL", url));
      expect(hazards(html)).toEqual([]); // <iframe> only on the allowlist is part of hazards()
    }), fuzzParams(400));
  });
});

describe("safeUrl fuzz", () => {
  it("returns the address only for a relative path, http, https, mailto or tel; any other scheme becomes #", () => {
    const url = fc.oneof(anyString, soup, fc.constantFrom("javascript:x", " JaVa\tScRiPt:x", "java\nscript:x", "\u0000javascript:x", "data:text/html,x", "vbscript:x", "//evil.example", "https://a.example", "mailto:a@b", "#frag", "/path", "a:b", "x javascript:y"));
    fc.assert(fc.property(url, (raw) => {
      const out = safeUrl(raw);
      if (out === "#") return;
      expect(out).toBe(raw.trim());
      // What a browser (the URL standard) reads as the scheme: tab and newlines dropped anywhere, leading controls and spaces trimmed.
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(out.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, ""))?.[1]?.toLowerCase();
      expect(scheme === undefined || ["http", "https", "mailto", "tel"].includes(scheme)).toBe(true);
    }), fuzzParams(3000));
  });
});

describe("custom CSS fuzz", () => {
  const reparser = unified().use(rehypeRaw);
  const css = fc.oneof(anyString, soup, fc.constantFrom("</style><script>x</script>", "</sty</stylele>", "<!--", "</STYLE >", "<\\/style>", "a{b:c}</style\t>", "\\3c /style>", "/*</style>*/"));

  it("cannot close its <style> element or add markup, and is capped", () => {
    fc.assert(fc.property(css, (raw) => {
      const out = sanitizeSiteCss(raw);
      expect(out.length).toBeLessThanOrEqual(SITE_CSS_MAX * 3); // `<` grows to `\3c `
      expect(out).not.toContain("<");
      // As a browser reads the page: exactly one element, the <style>, holding the text.
      let tree: Root;
      // parse5 itself throws on two lone low surrogates in a row: not what is under test.
      try { tree = reparser.runSync({ type: "root", children: [{ type: "raw", value: `<style>${out}</style><p>after</p>` }] } as unknown as Root) as Root; } catch { return; }
      const tags = tree.children.filter((c): c is Element => c.type === "element").map((e) => e.tagName);
      expect(tags).toEqual(["style", "p"]);
    }), fuzzParams(2000));
  });

  it("is idempotent and turns null, undefined and empty into empty", () => {
    expect(sanitizeSiteCss(null)).toBe("");
    expect(sanitizeSiteCss(undefined)).toBe("");
    fc.assert(fc.property(css, (raw) => {
      const once = sanitizeSiteCss(raw);
      // A second pass only re-escapes what the first cut at the cap: no `<` is left to change.
      expect(sanitizeSiteCss(once).replace(/\\3c /g, "<")).toBe(once.replace(/\\3c /g, "<").slice(0, SITE_CSS_MAX));
    }), fuzzParams(1000));
  });

  // Found by the nightly run, FUZZ_LONG=1 FUZZ_SEED=86019665 (2026-11-01): `@0\\<` gave `@0\<` then `@0<`.
  it("sanitizeSiteCss is idempotent for a backslash before `<`, and leaves no `<`", () => {
    for (const raw of ["@ <", "@\ufeff<", "@0\\\\<", "\\<", "a\\\\\\<b", "@\\\\\\<"]) {
      const once = sanitizeSiteCss(raw);
      expect(sanitizeSiteCss(once), raw).toBe(once);
      expect(once, raw).not.toContain("<");
    }
  });
});

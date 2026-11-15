// Fuzz: the SVG sanitizer (services/svgSanitize.ts). Uploaded and published
// SVGs are served as image/svg+xml, which a browser runs as a document, so the
// output must hold no script, handler, external reference, DOCTYPE or ENTITY,
// however the input spells them (entities, CDATA, namespaces, comments,
// encodings: fuzz-corpus/svg.json, inert markers only). Also: never throws,
// idempotent, linear time. Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sanitizeSvg } from "../services/svgSanitize.js";
import { expectLinearGrowth, expectWithinBudget, fuzzParams, hostileInput, loadCorpus, mutated } from "./fuzzSupport.js";
import { svgHazards } from "../../../markdown/src/test/htmlHazards.js";

const corpus = loadCorpus("svg");

// Corpus seeds that rebuild a script, a javascript: URL or a handler through an internal DTD entity.
const CSS_REFERENCE = "css-import|css-url-attr|css-url-entity|css-url-escape|fill-attr-url|filter-url|unicode-escape-css";
const ENTITY_SEEDS = ["doctype-entity-element", "doctype-entity-attr", "doctype-entity-onload", "doctype-entity-name-attr"];

describe("svg sanitizer fuzz", () => {
  it("every corpus seed comes out inert", () => {
    for (const [name, svg] of Object.entries(corpus)) {
      expect(svgHazards(sanitizeSvg(svg)), name).toEqual([]);
    }
  });

  it("XML entities rebuild a script, a javascript: URL or a handler after the filter", () => {
    // `<!DOCTYPE svg [<!ENTITY s "<script>…</script>">]><svg>&s;</svg>`: the regex filter sees
    // no script element, the DOCTYPE and ENTITY stay in the output, and an XML parser expands
    // &s; into a real <script> (stored XSS on image/svg+xml). Same for an entity holding
    // `javascript:…` in an href, or the value of an onload attribute.
    for (const name of ENTITY_SEEDS) expect(svgHazards(sanitizeSvg(corpus[name]!)), name).toEqual([]);
  });

  it("DOCTYPE and ENTITY declarations never survive (external DTD, parameter entities included)", () => {
    // Besides the script-building entities above: an external DTD address, SYSTEM / parameter entities,
    // lower-case `<!doctype`, one split by a comment.
    const forms = ["doctype-external-entity", "doctype-external-dtd", "doctype-parameter-entity", "doctype-lowercase", "doctype-split-comment", "entity-decl-only", "entity-decl-no-doctype", "doctype-entity"];
    for (const name of forms) expect(svgHazards(sanitizeSvg(corpus[name]!)), name).toEqual([]);
  });

  it("<meta http-equiv=refresh> and <base> are removed", () => {
    // `<svg><meta http-equiv="refresh" content="0;url=https://…"/></svg>`: `meta` and `base` are in the HTML parser's
    // list of tags that break out of SVG, so an SVG inlined into an HTML page redirects the page. Only the
    // href/src attributes are filtered, not `content`.
    const out = sanitizeSvg(corpus["meta-in-svg"]!);
    expect(out).not.toMatch(/<meta\b[^>]*http-equiv/i);
    expect(out).not.toMatch(/<base\b/i);
  });

  it("an event handler right after a closing quote is stripped (`title=\">\"onerror=…`)", () => {
    // The handler filter needs whitespace or `/` before `on…`. HTML and XML parsers accept (or, in HTML,
    // recover from) a new attribute straight after a quoted value, so `<svg title="x"onload="…">` keeps a live handler.
    for (const svg of ['<svg title="x"onload="__fuzz_marker"></svg>', "<svg a='1'onclick='__fuzz_marker'/>"]) expect(svgHazards(sanitizeSvg(svg)), svg).toEqual([]);
  });

  it("scripting elements under a namespace prefix are removed (`<x:script>`)", () => {
    // `<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>…</s:script></s:svg>`: served as
    // image/svg+xml the prefix is resolved by the XML parser and s:script is the SVG script
    // element; the regex only knows the bare names. Same for s:foreignObject.
    for (const name of ["script-case-ns", "script-default-ns-prefix", "foreign-object-ns"]) expect(svgHazards(sanitizeSvg(corpus[name]!)), name).toEqual([]);
  });

  it("named character references cannot hide a javascript: scheme (`java&Tab;script:`)", () => {
    // The href filter decodes numeric references and `&colon;`, not `&Tab;` or `&NewLine;`, which an HTML
    // parser decodes and a URL parser then drops, so `href="java&Tab;script:…"` is a live javascript: link when the
    // SVG is inlined into an HTML page (as XML, an undefined entity makes the file fail to parse instead).
    for (const name of ["href-javascript-tab-entity", "href-javascript-newline-entity"]) expect(svgHazards(sanitizeSvg(corpus[name]!)), name).toEqual([]);
  });

  it("external references written in CSS are removed (style attribute, <style> element)", () => {
    // `<rect style="fill:url(https://tracker.invalid/a#b)"/>`, `<style>@import url(https://…);</style>`, with the
    // `url` spelled with an entity or a CSS escape as well. Only javascript: is looked for in CSS; the href/src
    // allowlist does not apply to url(). Impact: a published or uploaded SVG can make the viewer's browser
    // contact a third-party host (tracking / data exfiltration), which the sanitizer's header says it prevents.
    for (const name of CSS_REFERENCE.split("|")) expect(svgHazards(sanitizeSvg(corpus[name]!)), name).toEqual([]);
  });

  it("random and mutated input never throws and stays in budget", () => {
    fc.assert(fc.property(hostileInput(corpus), (svg) => {
      expectWithinBudget("sanitizeSvg", svg, 150, () => { sanitizeSvg(svg); });
    }), fuzzParams(500));
  });

  it("mutated corpus output has no script, handler, external reference, DOCTYPE or ENTITY", () => {
    fc.assert(fc.property(mutated(corpus), (svg) => {
      const out = sanitizeSvg(svg);
      expect(sanitizeSvg(out)).toBe(out);
      expect(svgHazards(out)).toEqual([]);
    }), fuzzParams(1500));
  });

  // FINDING 2026-11-08 (nightly, FUZZ_LONG=1 FUZZ_SEED=412736143): an `xlinkhref` attribute (no colon) holding an
  // external address survives sanitizeSvg, which only knows `href` / `xlink:href`. The shared hazard check
  // (`svgHazards`) counts it as an external reference. Flip to `it` when the sanitizer drops it (or the check
  // is judged too strict for an attribute browsers do not treat as a link).
  it.fails("FINDING xlinkhref external reference survives the sanitizer", () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><use xlinkhref="//tracker.invalid/x.svg#a"/></svg>');
    expect(svgHazards(out)).toEqual([]);
  });

  it("removing a dangerous element cannot rebuild one: output is a fixed point", () => {
    // `<svg><scr<script>ipt/script>ipt></svg>`: the second regex removes the inner `<script>` and the
    // pieces around it join into `<script/script>ipt>`, a live script start tag. Same shape as the
    // closing-tag bypass of the custom CSS filter (GAP-244). A second pass removes it, so the
    // fix is to loop until nothing changes (or to parse instead of pattern-match).
    for (const svg of ["<svg><scr<script>ipt/script>ipt></svg>", corpus["nested-script"]!]) {
      const once = sanitizeSvg(svg);
      expect(svgHazards(once), svg).toEqual([]);
      expect(sanitizeSvg(once), svg).toBe(once);
    }
  });

  it("nightly 2026-10-24: stripping `javascript:` rebuilds an ENTITY declaration (`<javascript:!ENTITY …>`)", () => {
    // Found by the nightly run, FUZZ_SEED=1629073898 (2026-10-24), invariant "output has no DOCTYPE or ENTITY".
    // Likely cause: the javascript: scheme removal runs after the declaration check, so the pieces around it
    // join into `<!ENTITY …>`, which the output keeps (same family as the fixed-point finding above).
    for (const svg of ['<javascript:!ENTITY e "x">', '<svg><javascript:!ENTITY e "x"></svg>']) {
      expect(svgHazards(sanitizeSvg(svg)), svg).toEqual([]);
    }
  });

  it("repeated shapes grow linearly", () => {
    for (const unit of ["<g>", "<!--", "<svg a=\" ", "<a href=\"", " onload=", "&#x", "<![CDATA[", "</script ", "<a xlink:href=\"java", "<x y=1 "]) {
      expectLinearGrowth(`sanitizeSvg ${JSON.stringify(unit)}`, unit, (t) => { sanitizeSvg(t); }, { n: 3000, fastMs: 40 });
    }
  });

  it("a run of unclosed dangerous elements grows linearly", () => {
    // Each unclosed `<set ` (or `<script>`, `<animate `…) makes the lazy `[\\s\\S]*?` of the paired-element regex
    // scan to the end of the text: 12000 × "<set " (60 KB) takes ~1.6 s and grows ~13× per 4× input
    // (`<script>` ×12000, 96 KB: 0.2 s, same growth), so a few MB is minutes.
    expectLinearGrowth('sanitizeSvg "<set "', "<set ", (t) => { sanitizeSvg(t); }, { n: 2000, fastMs: 40, pairs: 2 });
  });

  // Found by the nightly run, FUZZ_LONG=1 FUZZ_SEED=1165917091 (2026-11-01): a BOM before the fragment in url().
  it("svg filter url() with a BOM before the fragment does not keep an external reference", () => {
    const svg = '<svg><rect filter="url(\uFEFF#//tracker.invalid/f.svg#f)"/></svg>';
    expect(svgHazards(sanitizeSvg(svg))).toEqual([]);
  });

  it("url() and href are judged after ignorable characters and CSS escapes are resolved", () => {
    const hosts = ["\uFEFF", "\u200B", "\u2060", "\u00A0", "\u2028", "\x01", "\\feff ", "\\200b ", "\\23 //tracker.invalid/f.svg#"];
    for (const pad of hosts) {
      for (const svg of [
        `<svg><rect filter="url(${pad}#//tracker.invalid/f.svg#f)"/></svg>`,
        `<svg><rect style="fill:url(${pad}//tracker.invalid/f.svg#f)"/></svg>`,
        `<svg><rect filter="url('${pad}//tracker.invalid/f.svg#f')"/></svg>`,
        ...(pad.startsWith("\\") ? [] : [ // CSS escapes mean nothing in an href
          `<svg><use href="${pad}//tracker.invalid/f.svg#f"/></svg>`,
          `<svg><use xlink:href="java${pad}script:alert(1)"/></svg>`,
        ]),
      ]) {
        const out = sanitizeSvg(svg);
        expect(out, svg).not.toContain("tracker.invalid");
        expect(out, svg).not.toContain("alert");
      }
    }
  });

  it("a plain local url(#id) and href=\"#id\" still pass", () => {
    const out = sanitizeSvg('<svg><rect filter="url(#f)" fill="url( \'#g.1\' )"/><use href="#f"/></svg>');
    expect(out).toContain('filter="url(#f)"');
    expect(out).toContain('href="#f"');
  });
});

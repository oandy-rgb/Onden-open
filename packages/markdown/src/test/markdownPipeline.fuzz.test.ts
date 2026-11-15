// Fuzz: the Markdown pipeline (app and published profiles) on random and
// hostile text. Invariants: never throws, finishes within a budget per KB,
// grows linearly on repeated pathological shapes, and its sanitized output has
// no script, handler, javascript:/vbscript:/non-media data: URL, style, base,
// meta or form (test/htmlHazards.ts). Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { type MarkdownProfile } from "../index.js";
import { ondenMarkdown } from "../full.js";
import { drawnWikilinks } from "../wikilinkSpans.js";
import { expectLinearGrowth, expectWithinBudget, fuzzParams, hostileInput, loadCorpus } from "./fuzzSupport.js";
import { htmlHazards, type IframePolicy } from "./htmlHazards.js";

const corpus = loadCorpus("markdown");

function renderer(profile: MarkdownProfile, math = true) {
  const md = ondenMarkdown({ profile, math, wikilinkHref: (l) => `/n/${encodeURIComponent(l.target ?? "")}` });
  const processor = unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions).use(md.rehypePlugins).use(rehypeStringify);
  return (text: string): string => String(processor.processSync(md.prepare(text)));
}
const renderers = { app: renderer("app"), published: renderer("published"), appNoMath: renderer("app", false) };
// The app profile parses inline HTML, so an <iframe> reaches the output; the
// React renderer then drops any whose host is off the allowlist (the schema
// can only constrain the scheme). Here the schema's own guarantee.
const IFRAME: Record<keyof typeof renderers, IframePolicy> = { app: "ignore", appNoMath: "ignore", published: "embed-allowlist" };

// Per-KB budget in milliseconds: generous (CI machines are slow and shared); a
// quadratic blow-up on a few KB overshoots it by orders of magnitude.
const PER_KB_MS = 400;

// Known findings (each has an it.fails case below and is listed in the PR):
//  - the schema lets `data:` through on img/video/audio/source/iframe src for
//    any media type, so `![x](data:text/html,…)` keeps a non-image data: URL
//    (inert inside <img>; the React renderer's urlTransform strips it);
//  - the app profile keeps an <iframe> to any https host or relative path
//    (only the renderers gate hosts, see mediaEmbed.ts; not checked for app);
//  - remark-wiki-link is quadratic on a long run of unclosed `[` or `[[`.
// The property tests drop the first from the report and leave the
// `[` runs out of the generated shapes; they check everything else.
const KNOWN_HAZARD = /non-media data: URL$/;
const hazards = (html: string, policy: IframePolicy) => htmlHazards(html, policy).filter((h) => !KNOWN_HAZARD.test(h));

describe("markdown pipeline fuzz", () => {
  for (const name of Object.keys(renderers) as Array<keyof typeof renderers>) {
    const render = renderers[name];

    it(`${name}: corpus seeds render, stay in budget and sanitize`, () => {
      for (const [seed, text] of Object.entries(corpus)) {
        let html = "";
        expectWithinBudget(`${name}/${seed}`, text, PER_KB_MS, () => { html = render(text); });
        expect(hazards(html, IFRAME[name]), `${name}/${seed}`).toEqual([]);
      }
    });

    it(`${name}: random and mutated input never throws, stays in budget, sanitizes`, () => {
      fc.assert(fc.property(hostileInput(corpus), (text) => {
        let html = "";
        expectWithinBudget(name, text, PER_KB_MS, () => { html = render(text); });
        expect(hazards(html, IFRAME[name])).toEqual([]);
      }), fuzzParams(100));
    });
  }

  it("repeated pathological shapes grow linearly (app and published)", () => {
    // One unit repeated: a quadratic rescan shows as ~16× time for 4× input.
    const units = [
      "![[", "[a](", "![a](", "`", "`` ` ``` ` ` ", "<", "a\n=\n", "---\n", "- a\n  - b\n", "www.", "a@", "|a", "#a/", "$", "$$ ", "\\",
      "&#", "<!--", "```\n", "<a x='1' ", "- [ ] ", "^id ", "{a, ", "key:: ", "> [!note] ", "~~",
    ];
    for (const unit of units) {
      for (const name of ["app", "published"] as const) expectLinearGrowth(`${name} ${JSON.stringify(unit)}`, unit, renderers[name], { n: 300, pairs: 2 });
    }
  });

  // ── Findings on main ──────────────────────────────────────────────────────
  // it.fails: the test passes while the bug exists and starts failing (so
  // someone notices and deletes `.fails`) once it is fixed.

  it.fails("FINDING remark-wiki-link: a run of unclosed `[` or `[[` is quadratic (both profiles)", () => {
    // 4000 × "[[" (8 KB) takes ~3 s, 8000 × "[[" (16 KB) ~12 s; 16000 × "[" ~12 s.
    // A note with a pasted run of brackets freezes the editor preview and the
    // server's published render. Parsing without the wiki-link plugin takes ~50 ms.
    for (const name of ["app", "published"] as const) for (const unit of ["[[", "["]) {
      expectLinearGrowth(`${name} ${JSON.stringify(unit)}`, unit, renderers[name], { n: 250 });
    }
  });

  it.fails("FINDING drawnWikilinks (the same plugin) is quadratic on a run of `[[a`", () => {
    // 6000 × "[[a" (18 KB) takes ~5.5 s; scanWikilinks on the same text takes 0 ms.
    expectLinearGrowth('drawnWikilinks "[[a"', "[[a", drawnWikilinks, { n: 900, pairs: 3, maxRatio: 6 });
  });

  it("<video poster> drops a javascript: URL", () => {
    const html = renderers.published('<video poster="javascript:x" src="https://a.example/v.mp4" controls></video>');
    expect(htmlHazards(html, "embed-allowlist")).toEqual([]);
  });

  it.fails("FINDING data: URL of any media type survives on <img src>", () => {
    const html = renderers.published("![x](data:text/html;base64,aW5lcnQ=)");
    expect(htmlHazards(html, "embed-allowlist")).toEqual([]);
  });

  it("a setext heading with an unclosed `![[` and a bare URL renders (headingTextEnd, nightly 2026-10-24)", () => {
    // Found by the nightly run, FUZZ_SEED=1408938955 (2026-10-24), invariant "never throws".
    // Likely cause: headingTextEnd (blocks.ts) reads `last.position.end` of the heading's
    // last child, but the autolinked URL inside the unclosed wiki-link has no position.
    for (const name of ["app", "published", "appNoMath"] as const) {
      expect(() => renderers[name]("![[https://e.\n---\nx"), name).not.toThrow();
    }
  });

  it.fails("FINDING deep nesting overflows the stack (RangeError thrown by the pipeline)", () => {
    // 500 × "<b><i><u>" (4.5 KB of unclosed inline tags) throws in both profiles;
    // 2000 × "<div>" and 4000 × "> " (8 KB) throw in the app profile. The editor
    // preview and the server's export fail instead of rendering.
    for (const name of ["app", "published"] as const) {
      expect(() => renderers[name]("<b><i><u>".repeat(500)), name).not.toThrow();
    }
    expect(() => renderers.app("<div>".repeat(2000))).not.toThrow();
    expect(() => renderers.app("> ".repeat(4000))).not.toThrow();
    // "> - " × 1000 (4 KB) throws in both; × 8000 first takes 15-20 s.
    for (const name of ["app", "published"] as const) expect(() => renderers[name]("> - ".repeat(1000)), name).not.toThrow();
  });

  it.fails("FINDING app profile keeps an <iframe> to any https host or same-origin path", () => {
    // An https host off the list, and a relative (same-origin) address.
    for (const src of ["https://evil.example/", "/api/media/x"]) {
      const html = renderers.app(`<iframe src="${src}"></iframe>`);
      expect(htmlHazards(html, "embed-allowlist"), src).toEqual([]);
    }
  });

  it.fails("FINDING micromark attention (mixed `*` and `_` delimiters) is quadratic", () => {
    // Upstream micromark (bare remark-parse, no Onden plugin): 8000 × "*_a" (24 KB)
    // takes ~3.3 s, 16000 × ~16 s ("**_" and "_*" alike). Runs of one delimiter are fast.
    expectLinearGrowth("app \"*_a\"", "*_a", renderers.app, { n: 1500, pairs: 3, maxRatio: 7 });
  });
});

describe("wikilink targets with lone surrogates", () => {
  it("[[\\udc00]] renders in every profile (seed 333612950)", () => {
    for (const name of Object.keys(renderers) as Array<keyof typeof renderers>) {
      expect(() => renderers[name]("[[\udc00]] [[a#\ud800]]"), name).not.toThrow();
    }
  });
});

// Random test of what an RSS article goes through before it is shown or saved:
//   - sanitizeFeedHtml and extractArticleHtml (modules/rss/sanitize.ts): untrusted HTML in, a body
//     that is safe to store out;
//   - htmlToMarkdown (modules/rss/htmlToMarkdown.ts, called by save.ts): the stored body as the
//     Markdown of a saved note, shown by the app's Markdown profile.
// All three are pure and database-free.
//
// HTML is generated from parts: ordinary text (paragraphs, code blocks, lists, inline code, with
// the words that look like attacks: " onClick={…}", "JavaScript:", "onerror=") and adversarial
// markup (script in every spelling, event handlers with every separator, javascript: URLs written
// with entities, tabs and nested recombination, iframes, embeds, tracking pixels). The output is
// judged with a small HTML5 tokenizer (helpers/htmlTokens.ts), the way a browser would read it, not
// with the cleaner's own regular expressions.
//
// Invariants:
//   1. no <script>, <object>, <embed> or <iframe> element survives (the YouTube / Vimeo player is
//      rewritten to a link by design), no attribute named on…, no attribute value whose URL scheme
//      is javascript:, no 1×1 tracking pixel
//   2. visible text is never removed: every paragraph, code sample and link label of the input is
//      still in the output, in order, with its " onClick={…}" and "JavaScript:" (a <form> block is
//      dropped whole by design and carries no text here)
//   3. cleaning is idempotent: cleaning a cleaned body changes nothing
//   4. time grows about linearly with input size: inputs of unclosed tags at 10 KB, 100 KB and 1 MB;
//      the test fails when ×10 the input costs more than ×40 the time (a ratio, not a wall-clock
//      limit; linear is ×10, quadratic ×100), and prints the timings. The time is this thread's CPU time, the fastest of
//      several repeats. It is not an operation count because the work is done by regular expressions (V8 reports no
//      steps for them) and a hand-written scanner whose counters would sit in product code
//   5. the conversion never throws, and a saved note keeps `<`, `$` and `[` as literal text: the
//      Markdown, rendered with the app profile, shows the article's words
//
// Known defects on main are KNOWN cases: a property over the part of the domain where the defect
// lives is `it.fails` (red the day it is fixed: drop the `.fails`), next to a minimal named case.
// Everything else runs over the rest of the domain and must stay green. No invariant is weakened:
// the domains only split which test owns a failure.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/rssSanitize.property.test.ts

import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { ondenMarkdown } from "@onden/markdown/full";
import { extractArticleHtml, sanitizeFeedHtml } from "../../modules/rss/sanitize.js";
import { htmlToMarkdown } from "../../modules/rss/htmlToMarkdown.js";
import { tokenizeHtml, urlSchemeOf, visibleText } from "../helpers/htmlTokens.js";
import { checkAsync, check } from "../helpers/propsConfig.js";
import { CLOCK_TICK_MS, typicalMs } from "../../../../markdown/src/linearTiming.testing.js";

// ── The parts a document is made of ─────────────────────────────────────────

type Defect = "text-on" | "text-js" | "attr-corrupt" | "unclosed" | "recombine" | "slash-handler" | "obfuscated-js" | "pixel";
/** `visible`: the text a reader must still see after cleaning ("" when the part has none). */
type Part = { html: string; visible: string; defect?: Defect; /** Unclosed markup swallows what follows it, so it goes last. */ last?: boolean };

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WORDS = ["alpha", "beta", "gamma", "onion", "one", "on", "button", "Java", "script", "JavaScript", "x=1", "a<b", "c>d", "50%", "$5", "[x]", "{y}", "日本語", "中文", "naïve", "é"];
const word = fc.constantFrom(...WORDS);
const safeText = fc.array(word, { minLength: 1, maxLength: 6 }).map((words) => words.join(" "));
/** Text a code sample or tutorial has, and the cleaning regexes read as attacks. */
const RISKY_ON = [" onClick={handleClick}", "<Button onClick={go} />", "set onload = init()", "el.onmouseover = f", 'x onerror="y" z', "<img src=x onerror=alert(1)>"];
const RISKY_JS = ["JavaScript: The Good Parts", "javascript:void(0)", "use javascript : URLs", "JAVASCRIPT:"];
const riskyText = (list: string[]) => fc.tuple(safeText, fc.constantFrom(...list), safeText).map(([a, b, c]) => `${a} ${b} ${c}`);

const textPart = (text: string, shape: number): Part => {
  const html = [`<p>${esc(text)}</p>`, `<pre><code>${esc(text)}</code></pre>`, `<ul><li>${esc(text)}</li></ul>`, `<p>see <code>${esc(text)}</code> here</p>`, `<blockquote>${esc(text)}</blockquote>`][shape % 5]!;
  return { html, visible: text };
};

/** Markup that is dangerous and that the cleaner handles today. `label` is the text around it that must stay. */
const WORKING: Array<(label: string) => Part> = [
  () => ({ html: "<script>alert(1)</script>", visible: "" }),
  () => ({ html: "<SCRIPT SRC=//evil.example/x.js></SCRIPT>", visible: "" }),
  () => ({ html: "<style>body{display:none}</style>", visible: "" }),
  () => ({ html: '<img src="x.png" onerror="alert(1)">', visible: "" }),
  (l) => ({ html: `<p ONCLICK="alert(1)">${esc(l)}</p>`, visible: l }),
  (l) => ({ html: `<div onmouseover=alert(1) class=a>${esc(l)}</div>`, visible: l }),
  (l) => ({ html: `<a href="javascript:alert(1)">${esc(l)}</a>`, visible: l }),
  (l) => ({ html: `<a href=" JaVaScRiPt:alert(1)">${esc(l)}</a>`, visible: l }),
  (l) => ({ html: `<a href='javascript:alert(1)'>${esc(l)}</a>`, visible: l }),
  () => ({ html: '<iframe src="https://evil.example/x"></iframe>', visible: "" }),
  () => ({ html: '<IFRAME SRC="https://evil.example/x">fallback</IFRAME>', visible: "" }),
  () => ({ html: '<iframe width="560" src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>', visible: "" }),
  () => ({ html: "<object data=x.swf></object>", visible: "" }),
  () => ({ html: "<embed src=x.swf />", visible: "" }),
  (l) => ({ html: `<!-- ${l} -->`, visible: "" }),
  () => ({ html: '<form action="/subscribe"><input name=email></form>', visible: "" }),
];

/** Markup the cleaner lets through today; each is one KNOWN defect. */
const DEFECTS: Array<{ defect: Defect; make: (label: string) => Part }> = [
  // sanitize.ts:17-18 look for a closing tag; without one the opening tag stays.
  { defect: "unclosed", make: () => ({ html: "<script>alert(1)", visible: "", last: true }) },
  { defect: "unclosed", make: () => ({ html: "<IFRAME src=https://evil.example/x>", visible: "", last: true }) },
  { defect: "unclosed", make: () => ({ html: "<embed src=x.swf>", visible: "", last: true }) },
  { defect: "unclosed", make: () => ({ html: "<object data=x.swf>", visible: "", last: true }) },
  // One pass of the regexes: what a removal joins together is not removed again.
  { defect: "recombine", make: () => ({ html: "<scr<script></script>ipt>alert(1)</script>", visible: "" }) },
  { defect: "recombine", make: () => ({ html: "<ifr<iframe></iframe>ame src=https://evil.example/x></iframe>", visible: "" }) },
  { defect: "recombine", make: (l) => ({ html: `<a href="javasjavascript:cript:alert(1)">${esc(l)}</a>`, visible: l }) },
  // sanitize.ts:20 wants whitespace before `on…`; a browser also starts an attribute after `/`.
  { defect: "slash-handler", make: () => ({ html: "<img/onerror=alert(1) src=x>", visible: "" }) },
  { defect: "slash-handler", make: () => ({ html: "<svg/onload=alert(1)>", visible: "" }) },
  { defect: "slash-handler", make: (l) => ({ html: `<a/href="#"/onclick=alert(1)>${esc(l)}</a>`, visible: l }) },
  // sanitize.ts:21-22 compare the raw attribute text; a browser decodes character references and drops tabs and line breaks first.
  { defect: "obfuscated-js", make: (l) => ({ html: `<a href="java&#115;cript:alert(1)">${esc(l)}</a>`, visible: l }) },
  { defect: "obfuscated-js", make: (l) => ({ html: `<a href="&#106;avascript:alert(1)">${esc(l)}</a>`, visible: l }) },
  { defect: "obfuscated-js", make: (l) => ({ html: `<a href="java&#x09;script:alert(1)">${esc(l)}</a>`, visible: l }) },
  { defect: "obfuscated-js", make: (l) => ({ html: `<a href="java\tscript:alert(1)">${esc(l)}</a>`, visible: l }) },
  { defect: "obfuscated-js", make: (l) => ({ html: `<a href="jav&#x0A;ascript:alert(1)">${esc(l)}</a>`, visible: l }) },
  // sanitize.ts:20 is not tag-aware: it cuts ` onclick=b` out of the middle of an attribute value, taking the closing quote with it.
  { defect: "attr-corrupt", make: (l) => ({ html: `<p title="a onclick=b">${esc(l)}</p>`, visible: l }) },
  { defect: "attr-corrupt", make: (l) => ({ html: `<a href="/x" title='the onload="y" attribute'>${esc(l)}</a>`, visible: l }) },
  // Nothing in sanitize.ts looks at an image's size.
  { defect: "pixel", make: () => ({ html: '<img src="https://track.example/p.gif" width="1" height="1">', visible: "" }) },
  { defect: "pixel", make: () => ({ html: "<img width=1 height=1 src=https://track.example/p.gif>", visible: "" }) },
  { defect: "pixel", make: () => ({ html: '<img src="https://track.example/p.gif" width="0" height="0" style="display:none">', visible: "" }) },
];

type DocOptions = { defects: Defect[]; /** At least one part of these defects. */ force: boolean };

function docArb(opts: DocOptions): fc.Arbitrary<{ html: string; parts: Part[] }> {
  const ordinary = fc.tuple(safeText, fc.nat(4)).map(([t, shape]) => textPart(t, shape));
  const working = fc.tuple(fc.constantFrom(...WORKING), safeText).map(([make, label]) => make(label));
  const defectParts: Array<fc.Arbitrary<Part>> = [];
  for (const d of DEFECTS.filter((x) => opts.defects.includes(x.defect))) defectParts.push(safeText.map((label) => ({ ...d.make(label), defect: d.defect })));
  if (opts.defects.includes("text-on")) defectParts.push(fc.tuple(riskyText(RISKY_ON), fc.nat(4)).map(([t, shape]) => ({ ...textPart(t, shape), defect: "text-on" as const })));
  if (opts.defects.includes("text-js")) defectParts.push(fc.tuple(riskyText(RISKY_JS), fc.nat(4)).map(([t, shape]) => ({ ...textPart(t, shape), defect: "text-js" as const })));
  const defect = defectParts.length > 0 ? fc.oneof(...defectParts) : null;
  return fc.tuple(
    fc.array(fc.oneof(ordinary, working), { maxLength: 5 }),
    defect ? fc.array(defect, { minLength: opts.force ? 1 : 0, maxLength: 3 }) : fc.constant<Part[]>([]),
    fc.constantFrom("", "\n", " "),
  ).map(([plain, bad, sep]) => {
    const parts = [...plain, ...bad.filter((p) => !p.last), ...bad.filter((p) => p.last)];
    return { html: parts.map((p) => p.html).join(sep), parts };
  });
}

// ── The invariants ──────────────────────────────────────────────────────────

const PIXEL_SIDE = (value: string | undefined) => value !== undefined && /^\s*[01]\s*(px)?\s*$/i.test(value);

/** Which of invariants 1 to 3 the cleaned body `output` breaks (empty = none). */
function violations(parts: Part[], output: string, clean: (html: string) => string = sanitizeFeedHtml): string[] {
  const broken: string[] = [];
  for (const token of tokenizeHtml(output)) {
    if (token.type !== "start") continue;
    if (["script", "object", "embed", "iframe"].includes(token.name)) broken.push(`<${token.name}> element survives`);
    for (const attr of token.attrs) {
      if (/^on/i.test(attr.name)) broken.push(`event handler ${attr.name} on <${token.name}>`);
      if (urlSchemeOf(attr.value) === "javascript") broken.push(`javascript: URL in ${attr.name} of <${token.name}>`);
    }
    if (token.name === "img") {
      const get = (name: string) => token.attrs.find((a) => a.name === name)?.value;
      if (PIXEL_SIDE(get("width")) && PIXEL_SIDE(get("height"))) broken.push("1×1 tracking pixel survives");
    }
  }
  const text = visibleText(output);
  let from = 0;
  for (const part of parts) {
    const wanted = part.visible.replace(/\s+/g, " ").trim();
    if (!wanted) continue;
    const at = text.indexOf(wanted, from);
    if (at < 0) broken.push(`visible text removed: ${JSON.stringify(wanted)}`);
    else from = at + wanted.length;
  }
  const again = clean(output);
  if (again !== output) broken.push(`not idempotent: ${JSON.stringify(output)} cleans to ${JSON.stringify(again)}`);
  return broken;
}

const page = (body: string) => `<html><head><title>T</title><meta charset="utf-8"></head><body><nav><a href="/">Home</a></nav><article>${body}</article><footer>© 2026</footer></body></html>`;

/** Both entry points over one document: the body sanitizer, and the full-text extractor on a page that holds it. */
function cleanedBoth(html: string): Array<[string, string, (h: string) => string]> {
  return [
    ["sanitizeFeedHtml", sanitizeFeedHtml(html), sanitizeFeedHtml],
    ["extractArticleHtml", extractArticleHtml(page(html), "https://example.com/post"), sanitizeFeedHtml],
  ];
}

function expectClean(doc: { html: string; parts: Part[] }): void {
  for (const [name, output, clean] of cleanedBoth(doc.html)) expect(violations(doc.parts, output, clean), `${name}(${JSON.stringify(doc.html)}) = ${JSON.stringify(output)}`).toEqual([]);
}

// ── 1 to 3: what the cleaner keeps and removes ──────────────────────────────

describe("1-3. cleaned bodies are safe, keep every visible word, and cleaning twice changes nothing", () => {
  it("text, code samples and the attacks the cleaner handles today (sanitizeFeedHtml and extractArticleHtml)", async () => {
    await checkAsync(fc.asyncProperty(docArb({ defects: [], force: false }), async (doc) => { expectClean(doc); }));
  }, 120_000);

  const KNOWN: Array<[Defect, string]> = [
    ["unclosed", "an opening <script>, <iframe>, <embed> or <object> with no closing tag (sanitize.ts:17-18)"],
    ["recombine", "markup that a removal joins into new markup, e.g. <scr<script></script>ipt> (sanitize.ts:17-22, one pass)"],
    ["slash-handler", "an event handler after `/` instead of a space, e.g. <img/onerror=…> (sanitize.ts:20)"],
    ["obfuscated-js", "javascript: written with character references, a tab or a line break (sanitize.ts:21-22)"],
    ["attr-corrupt", " onclick=… inside an attribute value cut out together with the closing quote (sanitize.ts:20)"],
    ["pixel", "a 1×1 tracking image (no rule in sanitize.ts)"],
    ["text-on", "code and prose with ` onClick={…}` lose it (sanitize.ts:20 is not tag-aware)"],
    ["text-js", "the word JavaScript: is deleted from prose (sanitize.ts:22 is not tag-aware)"],
  ];
  for (const [defect, what] of KNOWN) {
    it.fails(`KNOWN ${defect}: ${what}`, async () => {
      await checkAsync(fc.asyncProperty(docArb({ defects: [defect], force: true }), async (doc) => { expectClean(doc); }));
    }, 120_000);
  }

  // Minimal cases. Each fails alone with the output shown in the assertion message.
  const MINIMAL: Array<[string, string, string]> = [
    ["unclosed", "<p>hi</p><script>alert(1)", "an unclosed <script> stays, and runs"],
    ["unclosed", "<p>hi</p><IFRAME src=https://evil.example/x>", "an unclosed <IFRAME> stays"],
    ["recombine", "<scr<script></script>ipt>alert(1)</script>", "removing the inner <script> joins the outer one"],
    ["recombine", '<a href="javasjavascript:cript:alert(1)">x</a>', "removing the inner javascript: joins the outer one"],
    ["slash-handler", "<img/onerror=alert(1) src=x>", "`/` separates attributes in HTML"],
    ["obfuscated-js", '<a href="java&#115;cript:alert(1)">x</a>', "the browser decodes &#115; to s"],
    ["obfuscated-js", '<a href="java\tscript:alert(1)">x</a>', "the browser drops the tab"],
    ["attr-corrupt", '<p title="a onclick=b">kept text</p>', "the closing quote goes with ` onclick=b`"],
    ["pixel", '<img src="https://track.example/p.gif" width="1" height="1">', "a 1×1 image is a tracker"],
    ["text-on", "<p>Pass it as onClick={handleClick} to the button</p>", "the code in the sentence is deleted"],
    ["text-on", "<pre><code>&lt;Button onClick={go} /&gt;</code></pre>", "the code sample loses its handler"],
    ["text-js", "<p>JavaScript: The Good Parts is a book</p>", "the title of the book loses its first word"],
  ];
  for (const [defect, html, why] of MINIMAL) {
    it.fails(`KNOWN (minimal) ${defect}: ${why}`, () => {
      // The text a reader must still see is every text node of the input outside script/style.
      const parts: Part[] = tokenizeHtml(html).flatMap((t) => (t.type === "text" && !t.raw ? [{ html: "", visible: t.text }] : []));
      for (const [name, output, clean] of cleanedBoth(html).slice(0, 1)) expect(violations(parts, output, clean), `${name}(${JSON.stringify(html)}) = ${JSON.stringify(output)}`).toEqual([]);
    });
  }
});

// ── 4. time grows about linearly ────────────────────────────────────────────

const SIZES = [10_000, 100_000, 1_000_000];
/** ×10 the input may cost at most ×BOUND the time: linear is ×10, quadratic ×100. */
const BOUND = 40;
const make = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

type Sample = number | "threw";
/** The function's CPU time on this thread, the median of three batches (linearTiming.testing.ts: typicalMs). Not the wall clock:
 *  another test file's worker stretching one run of a 2-core runner made a linear function read as ×40 (2026-11-15), and under eight
 *  busy loops the wall-clock version of this test failed six runs out of six. Not an operation count: the work is regular
 *  expressions (V8 reports no steps for them) and a hand-written scanner whose counters would have to sit in product code. */
function measure(fn: (html: string) => unknown, unit: string, size: number): Sample {
  const html = make(unit, size);
  try { return typicalMs(() => { fn(html); }, 3); } catch { return "threw"; }
}

type Fn = { name: string; run: (html: string) => unknown };
const FNS: Record<"sanitize" | "extract" | "toMarkdown", Fn> = {
  sanitize: { name: "sanitizeFeedHtml", run: sanitizeFeedHtml },
  extract: { name: "extractArticleHtml", run: (html) => extractArticleHtml(`<html><body>${html}`, "https://example.com/post") },
  toMarkdown: { name: "htmlToMarkdown", run: (html) => htmlToMarkdown(html, "https://example.com/post") },
};

const timings: string[] = [];
const fmt = (s: Sample | undefined) => (s === undefined ? "not run" : s === "threw" ? "THREW" : `${s.toFixed(1)} ms`);

/** The ratios between the sizes, or what is wrong; stops at the first blow-up (a quadratic 1 MB would run for minutes). */
function growth(fn: Fn, unit: string): string[] {
  const samples: Sample[] = [];
  const problems: string[] = [];
  for (const [i, size] of SIZES.entries()) {
    const sample = measure(fn.run, unit, size);
    samples.push(sample);
    if (sample === "threw") { problems.push(`${fn.name} threw on ${size} bytes of ${JSON.stringify(unit)}`); break; }
    const before = samples[i - 1];
    if (typeof before === "number") {
      const ratio = sample / Math.max(before, i === 1 ? CLOCK_TICK_MS : 5);
      if (ratio > BOUND) { problems.push(`${fn.name} on ${JSON.stringify(unit)}: ×10 input (${SIZES[i - 1]! / 1000} KB → ${size / 1000} KB) took ×${ratio.toFixed(0)} the time`); break; }
    }
  }
  timings.push(`${fn.name.padEnd(20)} ${JSON.stringify(unit).padEnd(20)} ${fmt(samples[0]).padStart(10)} ${fmt(samples[1]).padStart(10)} ${fmt(samples[2]).padStart(10)}${problems.length ? "   <- " + problems[0] : ""}`);
  return problems;
}

afterAll(() => {
  if (timings.length > 0) process.stderr.write(`\n[rssSanitize.property] timings of unclosed-tag inputs (bound: ×10 input must cost < ×${BOUND} time)\n${"function".padEnd(20)} ${"input unit".padEnd(20)} ${"10 KB".padStart(10)} ${"100 KB".padStart(10)} ${"1 MB".padStart(10)}\n${timings.sort().join("\n")}\n`);
});

const LINEAR: Record<keyof typeof FNS, string[]> = {
  sanitize: ["<p>", "<b>", "<div>", "<li>", '<a href="x', "<img src=x ", "<", " onx ", "javascript ", "<table><tr><td>", "[", "< ", "<img "],
  extract: ["<p>", "<b>", "<div>", "<li>", " onx ", "[", "<table><tr><td>", "<em><b>", "<ul><li>", "<blockquote>", "<span>", "<p><b>", "<td>", "<script>", "<style>", "</div>"],
  toMarkdown: ["<li>", "<", " onx ", "[", "< ", "</div>"],
};
const QUADRATIC: Record<keyof typeof FNS, string[]> = {
  sanitize: ["<script ", "<iframe ", "<!--"],
  extract: ["<script ", "<iframe ", "<!--", "<", "< ", "<img ", "<img src=x ", '<a href="x'],
  toMarkdown: ['<a href="x', "<img src=x ", "<img ", "<script ", "<iframe ", "<!--"],
};
/** Deep nesting: htmlToMarkdown walks the tree recursively. */
const DEEP = ["<b>", "<div>", "<span>", "<blockquote>", "<ul><li>", "<table><tr><td>", "<em><b>", "<p><b>", "<td>"];

describe("4. time grows about linearly with the input (unclosed tags, 10 KB / 100 KB / 1 MB)", () => {
  for (const key of ["sanitize", "extract", "toMarkdown"] as const) {
    it(`${FNS[key].name}: ${LINEAR[key].length} kinds of unclosed markup stay linear`, () => {
      const problems = LINEAR[key].flatMap((unit) => growth(FNS[key], unit));
      expect(problems).toEqual([]);
    }, 300_000);
  }

  // KNOWN: sanitize.ts:17 `<\s*(script|…)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>` (and :19 for comments, keepVideoEmbeds :32 for iframes, and
  // articleExtract.ts' scanners) look for a closing token from every opening one; with N openers and no closer each scans to the
  // end of the input, N × N. 100 KB of `<script ` costs seconds; 1 MB costs minutes, and a feed may be 25 MB (FEED_MAX_BYTES).
  for (const key of ["sanitize", "extract", "toMarkdown"] as const) {
    for (const unit of QUADRATIC[key]) {
      it.fails(`KNOWN: ${FNS[key].name} on a run of ${JSON.stringify(unit)} is not quadratic`, () => {
        expect(growth(FNS[key], unit)).toEqual([]);
      }, 300_000);
    }
  }

  // KNOWN: htmlToMarkdown.ts parse() builds one nested element per unclosed tag and textOf / blocks / inline recurse
  // over them: a few thousand to tens of thousands of open tags is "Maximum call stack size exceeded", so POST /items/:id/save answers 500.
  for (const unit of DEEP) {
    it.fails(`KNOWN: htmlToMarkdown does not throw on 100 KB of ${JSON.stringify(unit)}`, () => {
      expect(() => htmlToMarkdown(make(unit, 100_000))).not.toThrow();
    });
  }
});

// ── 5. the saved note ───────────────────────────────────────────────────────

const app = ondenMarkdown({ profile: "app" });
/** The note as the app shows it. */
const renderNote = (markdown: string) => String(unified().use(remarkParse).use(app.remarkPlugins).use(remarkRehype, app.remarkRehypeOptions).use(app.rehypePlugins).use(rehypeStringify).processSync(app.prepare(markdown)));

const norm = (text: string) => text.replace(/\s+/g, " ").trim();
/** How the note, rendered with the app's profile, differs from the article's paragraphs (empty = shown exactly as written). */
function lostFromNote(paragraphs: string[], html: string): string[] {
  const markdown = htmlToMarkdown(html);
  const seen = norm(visibleText(renderNote(markdown)));
  const wanted = norm(paragraphs.join(" "));
  return seen === wanted ? [] : [`wanted ${JSON.stringify(wanted)}, the note shows ${JSON.stringify(seen)} (markdown ${JSON.stringify(markdown)})`];
}
const articleOf = (paragraphs: string[]) => paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n");

/** Words that Markdown has no reading for in the middle of a sentence. */
const PLAIN = ["alpha", "beta", "gamma", "x=1", "50%", "(z)", "a|b", "c>d", "日本語", "中文", "naïve", "snake_case", "*star*", "`tick`", "# not a heading", "1 < 2", "a & b", "a  b", "http://example.com/a_b_c"];
const plain = fc.array(fc.constantFrom(...PLAIN), { minLength: 1, maxLength: 5 }).map((w) => w.join(" "));
const paragraphs = (trigger: fc.Arbitrary<string>) => fc.tuple(fc.array(plain, { maxLength: 2 }), fc.array(fc.tuple(plain, trigger, plain).map(([a, t, b]) => `${a} ${t} ${b}`), { minLength: 1, maxLength: 3 }));

describe("5. saving as a note keeps the article's words as literal text", () => {
  it("ordinary prose, code spans, snake_case, `1 < 2`, entities, CJK: shown as written", async () => {
    await checkAsync(fc.asyncProperty(fc.array(plain, { minLength: 1, maxLength: 4 }), async (ps) => {
      expect(lostFromNote(ps, articleOf(ps))).toEqual([]);
    }));
  });

  it("the conversion never throws on ordinary markup at any depth a real article has", () => {
    check(fc.property(fc.array(fc.constantFrom("<div>", "<span>", "<b>", "<p>", "<li>", "<ul>", "</div>", "</b>", "text ", "<br>", "<a href=x>"), { maxLength: 60 }), (chunks) => {
      expect(() => htmlToMarkdown(chunks.join(""))).not.toThrow();
    }));
  });

  // The three the app's Markdown reads as syntax when they are plain text in the article.
  const TRIGGERS: Array<[string, fc.Arbitrary<string>, string]> = [
    ["<", fc.constantFrom("<div>", "<b>", "<span>", "<tag>", "<img>", "<a>"), "an angle-bracket word such as <div> is read as an HTML tag and disappears (htmlToMarkdown.ts:78 escapeInline)"],
    ["$", fc.constantFrom("$5 and $10", "$x$", "cost $3, then $4"), "two dollar signs make math (htmlToMarkdown.ts:78 escapeInline)"],
    ["[", fc.constantFrom("[x](y)", "[link](https://example.com)", "![img](u)"), "[text](url) becomes a link (htmlToMarkdown.ts:78 escapeInline only escapes [[)"],
  ];
  for (const [name, trigger, what] of TRIGGERS) {
    it.fails(`KNOWN ${name}: ${what}`, async () => {
      await checkAsync(fc.asyncProperty(paragraphs(trigger), async ([before, withTrigger]) => {
        const ps = [...before, ...withTrigger];
        expect(lostFromNote(ps, articleOf(ps))).toEqual([]);
      }));
    });
  }

  // More of the same family found by this test. Each is one article sentence that the note does not show as written.
  const ALSO: Array<[string, string]> = [
    ["use the <div> element", "<tag> words"],
    ["costs $5 and $10", "dollar pairs"],
    ["write [x](y) for a link", "link syntax"],
    ["~~not struck~~", "~~ is strikethrough"],
    ["H~2~O", "single ~ pairs are strikethrough"],
    ["use &amp; for an ampersand", "an entity written as text is decoded once more"],
    ["1. not a list", "a line that starts like a list gets a visible backslash (escapeLineStart, htmlToMarkdown.ts:88, writes \\1.)"],
    ["---", "a paragraph of three dashes is a thematic break"],
    [">quoted-looking", "a line that starts with > and no space is a quote"],
    ["a \\\\ b and \\*", "a backslash before punctuation is eaten"],
    ["__init__ and __main__", "double underscores around a word"],
  ];
  for (const [sentence, why] of ALSO) {
    it.fails(`KNOWN (minimal): "${sentence}" — ${why}`, () => {
      expect(lostFromNote([sentence], articleOf([sentence]))).toEqual([]);
    });
  }
});

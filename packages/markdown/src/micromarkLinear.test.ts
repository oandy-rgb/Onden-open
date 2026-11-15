// patches/micromark+4.0.2.patch rewrites micromark's `resolveAllText` (the
// merge of adjacent `data` events in text and string content) from one
// `splice` per run into one in-place pass: long multi-line paragraphs parsed
// in quadratic time (gfm's autolink literal splits every line into several
// data tokens, so each line was a run). The patch must not change any output.
//
// The oracle is micromark's original merge loop, copied below. Running it
// first leaves no adjacent data runs, so the patched resolver after it only
// adds its line-suffix pass: the oracle resolver is "original merge, then
// patched". Both micromark builds (`lib/` and `dev/lib/`, the latter picked
// by the `development` export condition) are swapped, whichever one this
// process loaded.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { micromark, parse, postprocess, preprocess } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Event, Resolver } from "micromark-util-types";
// The file paths rather than the package: micromark exports neither module.
import * as libText from "../../../node_modules/micromark/lib/initialize/text.js";
import * as devText from "../../../node_modules/micromark/dev/lib/initialize/text.js";

/** micromark 4.0.2's `resolveAllText` merge, verbatim but for the types. */
function originalMerge(events: Event[]): Event[] {
  let index = -1;
  let enter: number | undefined;
  while (++index <= events.length) {
    if (enter === undefined) {
      if (events[index] && events[index][1].type === "data") {
        enter = index;
        index++;
      }
    } else if (!events[index] || events[index][1].type !== "data") {
      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end;
        events.splice(enter + 2, index - enter - 2);
        index = enter + 2;
      }
      enter = undefined;
    }
  }
  return events;
}

type Construct = { resolveAll?: Resolver };
const constructs = (m: typeof libText): Construct[] => [m.text, m.string, m.resolver] as Construct[];
const patched = new Map<Construct, Resolver>();
for (const m of [libText, devText]) for (const c of constructs(m)) patched.set(c, c.resolveAll!);

function useOracle(on: boolean) {
  for (const [construct, resolve] of patched) {
    construct.resolveAll = on ? (events, context) => resolve(originalMerge(events), context) : resolve;
  }
}

/** Everything a parse yields: the event stream (with positions), the HTML
 *  and the mdast (with positions) of the remark pipeline the app parses with. */
function outputs(markdown: string) {
  const events = postprocess(parse({ extensions: [gfm()] }).document().write(preprocess()(markdown, undefined, true)));
  return {
    events: events.map(([kind, token]) => [kind, token.type, token.start.offset, token.end.offset, token.start._index, token.start._bufferIndex, token.end._index, token.end._bufferIndex]),
    html: micromark(markdown, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] }),
    commonmark: micromark(markdown),
    mdast: unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown),
  };
}

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../..");
function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return /\.(md|markdown)$/.test(name) ? [path] : [];
  });
}

// A seeded generator, so a failure names an input that can be reproduced.
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
}
const ATOMS = [
  "a", "b", "w", "h", "x", " ", "  ", "\t", "\n", "\r\n", "\r", "\n\n", "*", "_", "**", "~", "~~", "`", "[", "]", "(", ")",
  "!", "<", ">", "&amp;", "\\", "#", "-", "1.", "|", ":", "@", ".", "/", "^", "$", "{", "}", "中", "文", "é", "\0",
  "www.", "http://", "https://", "localhost:5199", "mailto:", "x@y.z", "[[", "]]", "[^1]", "- [ ] ", "> ", "    ", "```",
];
function fuzz(rand: () => number, length: number): string {
  let out = "";
  while (out.length < length) out += ATOMS[Math.floor(rand() * ATOMS.length)];
  return out;
}

const tricky: Record<string, string> = {
  empty: "",
  "only newline": "\n",
  "only crlf": "\r\n",
  "one word": "word",
  "cjk autolinks": "請看https://example.com/路徑。還有www.example.org，以及中文www.例子.公司結尾",
  "localhost urls": "http://localhost:5199/a and localhost:5199 and https://127.0.0.1:8787/x?y=1#z",
  "non-ascii domains": "https://例子.測試/路徑 www.bücher.de/ä mailto:用户@例子.广告",
  "emails next to text": "write a@b.co,c@d.org. or 中文e@f.net。",
  "emphasis runs": "*a **b *c* d** e* _f __g__ h_ ***i*** ~~j~~ ~k~ " + "*x".repeat(200),
  "trailing spaces": "line one  \nline two   \nline three\t\nend  ",
  "hard breaks crlf": "a  \r\nb\\\r\nc  \r\n",
  "crlf paragraphs": "first line\r\nsecond https://a.example\r\n\r\nnext *para*\r\n",
  "lone cr": "a\rb\rc www.x.com\r",
  "tabs and virtual spaces": "\ta\tb  \t\n\t\tcode\n>\tquote",
  "table": "| a | b |\n| - | :-: |\n| www.x.com | *y* |\n| 中 | z  |",
  "footnotes": "Text[^1] and [^note].\n\n[^1]: www.foot.example\n[^note]: second  \n    continued",
  "tasks": "- [ ] one www.a.com\n- [x] two\n  - [ ] nested  \n",
  "html and entities": "<div>www.x.com</div> &amp; &#123; &copy; <span>a</span>  \n",
  "code spans": "`a``b` ``www.x.com`` `` ` `` text",
  "math": "$a$ and $$b$$\n\n$$\nwww.x.com\n$$",
  "string content": "[link](https://a.b/c d 'title www.x.com') ![img](<a b> \"t\")\n\n```js meta www.x.com\ncode\n```",
  "references": "[a]: https://x.example 'T'\n\n[a] [b][a] [a][]",
  "long multi-line paragraph": "k: v\n".repeat(4000),
  "long autolink paragraph": "see https://example.com/a 中文www.b.org localhost:5199 x@y.z\n".repeat(1000),
  "long prose with trailing spaces": "Some words, and more  \n".repeat(1500),
};

describe("micromark's one-pass data merge (patches/micromark+4.0.2.patch)", () => {
  beforeAll(() => useOracle(false));
  afterAll(() => useOracle(false));

  it("is applied to both micromark builds", () => {
    // Without the patch the comparisons below compare the original with
    // itself and pass anyway; this is what fails when postinstall didn't run.
    for (const m of [libText, devText]) {
      for (const construct of constructs(m)) expect(String(construct.resolveAll)).toContain("events.length = write");
    }
  });

  function same(label: string, markdown: string) {
    useOracle(true);
    const expected = outputs(markdown);
    useOracle(false);
    const actual = outputs(markdown);
    expect(actual.events, `${label}: events`).toEqual(expected.events);
    expect(actual.html, `${label}: html`).toBe(expected.html);
    expect(actual.commonmark, `${label}: commonmark html`).toBe(expected.commonmark);
    expect(actual.mdast, `${label}: mdast`).toEqual(expected.mdast);
  }

  it("parses tricky inputs as the original did", () => {
    for (const [label, markdown] of Object.entries(tricky)) same(label, markdown);
  }, 120_000);

  it("parses the repo's markdown (docs, READMEs, fixtures) as the original did", () => {
    const files = [...markdownFiles(join(repo, "docs")), join(repo, "README.md"), join(repo, "AGENTS.md"), join(here, "../README.md")];
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) same(file, readFileSync(file, "utf8"));
    for (const fixture of readdirSync(join(here, "fixtures"))) same(fixture, readFileSync(join(here, "fixtures", fixture), "utf8"));
  }, 120_000);

  it("parses random inputs as the original did", () => {
    const rand = random(20261018);
    for (let i = 0; i < 1500; i++) {
      const markdown = fuzz(rand, 1 + Math.floor(rand() * 300));
      same(`fuzz #${i} ${JSON.stringify(markdown)}`, markdown);
    }
  }, 120_000);
});

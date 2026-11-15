import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SELF_FOLDING, snippetAround, snippetAroundWholeNote, snippetPlainText, queryTerms, type Snippet } from "./snippet.js";
import { replaceWikilinks, splitWikilink } from "./text.js";
import { stripFrontmatter } from "./frontmatter.js";
import { withoutLineTrailers } from "./blockId.js";
import { checklistLine, plainAroundSpan } from "./plainText.js";

// The shared fixture: the server and the app's local index are held to it too
// (backend searchSnippets.integration.test.ts, frontend searchSnippets.test.ts).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/searchSnippets.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; markdown: string; query: string; expected: Snippet }>;
};

/** The highlighted substrings, as a reader sees them. */
const marked = (s: Snippet | null) => s?.ranges.map(([a, b]) => s.text.slice(a, b)) ?? null;

describe("snippetAround (search snippet contract, D76)", () => {
  for (const c of fixture.cases) {
    it(`fixture: ${c.name}`, () => {
      expect(snippetAround(c.markdown, queryTerms(c.query))).toEqual(c.expected);
    });
  }

  it("keeps & and < as the note wrote them (no HTML escaping, no markup read)", () => {
    const s = snippetAround("Q&A for <tips> about <mark>x</mark> kafka", ["kafka"])!;
    expect(s.text).toBe("Q&A for <tips> about <mark>x</mark> kafka");
    expect(marked(s)).toEqual(["kafka"]);
  });

  it("ranges land on the matched characters, case-insensitively", () => {
    expect(marked(snippetAround("Learning KAFKA and Kafka streams", ["kafka"]))).toEqual(["KAFKA", "Kafka"]);
  });

  it("highlights CJK terms", () => {
    const s = snippetAround("今天學習了分散式系統的共識演算法", ["共識"])!;
    expect(marked(s)).toEqual(["共識"]);
  });

  it("counts astral emoji as two UTF-16 units and never splits one", () => {
    const s = snippetAround("😀😀 kafka 😀", ["kafka"])!;
    expect(s.ranges).toEqual([[5, 10]]);
    // A window edge inside a run of emoji moves off the surrogate pair.
    const long = snippetAround("😀".repeat(60) + "kafka", ["kafka"], { before: 5 })!;
    expect(long.text.startsWith("…")).toBe(true);
    expect(long.text.charCodeAt(1)).toBe(0xd83d);
    expect(marked(long)).toEqual(["kafka"]);
  });

  it("matches decomposed (NFD) text with a composed (NFC) term and highlights the whole character", () => {
    const s = snippetAround("Café review", ["café"])!;
    expect(s.ranges).toEqual([[0, 5]]);
    expect(snippetAround("Café review", ["café"])!.ranges).toEqual([[0, 4]]);
  });

  it("folds width like pgroonga's normalizer (full-width matches ASCII)", () => {
    expect(marked(snippetAround("ＫＡＦＫＡ full width", ["kafka"]))).toEqual(["ＫＡＦＫＡ"]);
  });

  it("is null when only the title matched", () => {
    expect(snippetAround("nothing relevant", ["kafka"])).toBeNull();
    expect(snippetAround("", ["kafka"])).toBeNull();
    expect(snippetAround("kafka", [])).toBeNull();
  });

  it("leaves the frontmatter out", () => {
    expect(snippetAround("---\nstatus: reading\n---\nbody", ["reading"])).toBeNull();
  });

  it("prefers the longer term where two start together", () => {
    expect(marked(snippetAround("kafka streams rock", ["kafka", "kafka streams"]))).toEqual(["kafka streams"]);
  });
});

describe("snippetPlainText", () => {
  it("drops heading marks, emphasis and link brackets, keeps a #tag", () => {
    expect(snippetPlainText("## Section\n#tag and **bold** `code` [[A|alias]] [[B]]\n\n  next"))
      .toBe("Section #tag and bold code alias B next");
  });

  it("collapses whitespace runs, NBSP and blank lines into one space, nothing at the ends", () => {
    expect(snippetPlainText("\n\n  a  b\t\r\n\r\n###### c ####### d  ")).toBe("a b c ####### d");
    expect(snippetPlainText("**`*`**")).toBe("");
  });

  // Search builds a snippet for each of up to 50 hits. Appending one character
  // at a time went quadratic in V8 on strings decoded from a Buffer (what
  // node-postgres hands over): ~20 s per search, with the server's event loop
  // blocked (perf report 2026-10-21). This takes ~30 ms per pass when linear.
  it("stays linear over many long bodies decoded from a Buffer, pass after pass", () => {
    const para = "Some **bold** text with `code` and [[Link|alias]] words 中文字元 ".repeat(40) + "\n\n## Heading\n";
    const bodies = Array.from({ length: 50 }, (_, i) => Buffer.from(`# Note ${i}\n${para.repeat(20)}`).toString("utf8"));
    const started = performance.now();
    for (let pass = 0; pass < 3; pass++) for (const body of bodies) snippetPlainText(body);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("queryTerms", () => {
  it("reads the query as pgroonga_query_extract_keywords does", () => {
    expect(queryTerms('Kafka OR "foo bar" -baz 你好')).toEqual(["Kafka", "foo bar", "你好"]);
  });
});

describe("case folding that changes length", () => {
  it("maps ranges back to the original text", () => {
    // "İ" lower-cases to two units: an index into the lower-cased text is off by one.
    expect(marked(snippetAround("İstanbul kafka", ["kafka"]))).toEqual(["kafka"]);
  });
});

// ---- Golden and window tests (perf report 2026-10-21, F1) ----

/** snippetPlainText as it was before it collected slices: one `out += ch` per
 *  kept character. The new one must return the same text byte for byte. */
function legacyPlainText(markdown: string): string {
  const linked = replaceWikilinks(stripFrontmatter(markdown), (inner) => {
    const { target, alias } = splitWikilink(inner);
    return alias ?? target;
  });
  // The app's marks (task box, {tag}, ^id) are not words: the same line pass as snippet.ts.
  const body = withoutLineTrailers(linked).split("\n").map((l) => checklistLine(l)?.text ?? l).join("\n");
  let out = "";
  let lineStart = true;
  let pendingSpace = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (lineStart) {
      let j = i;
      while (j < body.length && j - i < 6 && body[j] === "#") j++;
      if (j > i && (body[j] === " " || body[j] === "\t")) { i = j; pendingSpace = out.length > 0; lineStart = false; continue; }
    }
    if (ch === "\n" || ch === "\r") { lineStart = true; pendingSpace = out.length > 0; continue; }
    lineStart = false;
    if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v" || ch === "\u00a0") { pendingSpace = out.length > 0; continue; }
    if (ch === "*" || ch === "`") continue;
    if (pendingSpace) { out += " "; pendingSpace = false; }
    out += ch;
  }
  return out;
}

/** A small seeded generator, so a failure names its seed and replays. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}

const WORDS = ["kafka", "Streams", "演算法", "期中考", "résumé", "Ａｌｐｈａ", "emoji😀", "e\u0301cole", "ΑΣ", "İstanbul", "naïve", "plain", "text", "x", "TODO", "數據結構", "ß", "ﬁnal"];
const PIECES: Array<(w: () => string, r: () => number) => string> = [
  (w) => w(), (w) => w(), (w) => w(), (w) => w(),
  (w) => `**${w()}**`, (w) => `\`${w()}\``, (w) => `[[${w()}]]`, (w) => `[[${w()}|${w()}]]`,
  (w) => `[${w()}](https://example.com/${w()})`, (w) => `#${w()}`, (w) => `| ${w()} | ${w()} |`,
  (w) => `![](ink:${w()})`, (w) => `<ink id="${w()}"/>`, (_w, r) => "\n".repeat(1 + Math.floor(r() * 3)),
  (w) => `\n## ${w()}\n`, (w) => `\n- [ ] ${w()}\n`, () => "\n```ts\nconst a = 1;\n```\n", () => "\r\n", () => "\u00a0\t ", () => "\n---\n",
];

function markdownNote(seed: number, length: number, frontmatter: boolean): string {
  const r = rng(seed);
  const word = () => WORDS[Math.floor(r() * WORDS.length)]!;
  // Pieces are separated by a space or a line break, so no markup splits a word:
  // the case where the window path and the whole note agree (see snippetAround).
  let out = frontmatter ? `---\ntitle: ${word()}\ntags: [a, b]\n---\n` : "";
  while (out.length < length) out += PIECES[Math.floor(r() * PIECES.length)]!(word, r) + (r() < 0.3 ? "\n" : " ");
  return out;
}

describe("snippetPlainText golden", () => {
  it("returns the same text as the character-by-character version on varied markdown", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const md = markdownNote(seed, 200 + seed * 40, seed % 3 === 0);
      expect(snippetPlainText(md), `seed ${seed}`).toBe(legacyPlainText(md));
    }
  });

  it("returns the same text on awkward edges", () => {
    for (const md of ["", " ", "\n", "#", "# ", "####### x", "#tag\n# h", "**", "[[", "[[a|b", "[[a]]]]", "---\n---\n", "---\na: b\n---", "a\r\n\r\nb", "\ud83d", "x\u0301**y**"]) {
      expect(snippetPlainText(md), JSON.stringify(md)).toBe(legacyPlainText(md));
    }
  });

  it("pins the output for one note of each kind", () => {
    const md = [
      "---\ntitle: T\n---", "# Kafka 筆記", "", "**重點**：`code` 與 [[演算法|algo]]、[[Plain]]。", "",
      "| a | b |", "|---|---|", "| 1 | *2* |", "", "```ts", "const x = 1;", "```", "![](ink:abc123)", "<ink id=\"z\"/>", "  - [ ] todo\u00a0item", "#tag 結尾",
    ].join("\n");
    expect(snippetPlainText(md)).toBe("Kafka 筆記 重點：code 與 algo、Plain。 | a | b | |---|---| | 1 | 2 | ts const x = 1; ![](ink:abc123) <ink id=\"z\"/> todo item #tag 結尾");
  });
});

describe("snippetAround window path", () => {
  const queries: string[][] = [["kafka"], ["演算法"], ["streams", "plain"], ["résumé"], ["alpha"], ["ecole"], ["\u00e9cole"], ["istanbul"], ["TODO"], ["final"], ["emoji😀"], ["absent-term"], ["x"]];

  it("equals reading the whole note, for notes of different sizes, with and without frontmatter", { timeout: 60000 }, () => {
    for (let seed = 1; seed <= 40; seed++) {
      const md = markdownNote(seed, seed % 4 === 0 ? 400 : 9000 + seed * 700, seed % 5 === 0);
      for (const q of queries) {
        expect(snippetAround(md, q), `seed ${seed} ${q}`).toEqual(snippetAroundWholeNote(md, q));
      }
    }
  });

  it("equals reading the whole note when the first match is far from the start and from the end", () => {
    const filler = "plain text and more plain text.\n".repeat(4000);
    for (const tail of ["", "\n" + "plain ".repeat(300)]) {
      const md = `${filler}the needle sits here ${tail}\n${filler}`;
      expect(snippetAround(md, ["needle"])).toEqual(snippetAroundWholeNote(md, ["needle"]));
    }
    const cjk = "這是一段很長的中文內容。".repeat(5000);
    const md = `${cjk}演算法${cjk}`;
    expect(snippetAround(md, ["演算法"])).toEqual(snippetAroundWholeNote(md, ["演算法"]));
  });

  it("treats as self-folding only characters that NFKC and lower-casing leave alone", () => {
    let count = 0;
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (!SELF_FOLDING.test(ch)) continue;
      count++;
      if (c >= 0x80) expect(ch.normalize("NFKC") === ch && ch.toLowerCase() === ch && !/\p{M}/u.test(ch), `U+${c.toString(16)}`).toBe(true);
    }
    expect(count).toBeGreaterThan(30000);
  });

  it("finds a match across the cut between two scanned chunks", () => {
    for (let pad = 8150; pad < 8250; pad++) {
      const md = "a".repeat(pad) + "needle" + "b".repeat(300);
      expect(snippetAround(md, ["needle"]), `pad ${pad}`).toEqual(snippetAroundWholeNote(md, ["needle"]));
    }
  });

  it("falls back to the whole note for a quoted phrase across a line break", () => {
    const md = "x ".repeat(5000) + "foo\nbar" + " y".repeat(5000);
    expect(snippetAround(md, ["foo bar"])?.ranges.length).toBe(1);
    expect(snippetAround(md, ["foo bar"])).toEqual(snippetAroundWholeNote(md, ["foo bar"]));
  });

  it("skips a match that only occurs in a link target the plain text drops", () => {
    const md = "intro ".repeat(2000) + "[[kafka|a link]]\n" + "middle ".repeat(3000) + "\nreal kafka text here\n" + "end ".repeat(500);
    const s = snippetAround(md, ["kafka"])!;
    expect(s.text).toContain("real kafka text");
    expect(snippetAround(md, ["kafka"])).toEqual(snippetAroundWholeNote(md, ["kafka"]));
  });

  it("does not show frontmatter as a match, and keeps a mid-note `---` rule a rule", () => {
    const md = "---\ntitle: kafka\n---\n" + "word ".repeat(4000) + "\n---\nafter the rule kafka\n" + "tail ".repeat(3000);
    expect(snippetAround(md, ["kafka"])).toEqual(snippetAroundWholeNote(md, ["kafka"]));
    expect(snippetAround(md, ["kafka"])?.text).toContain("after the rule kafka");
  });

  it("reads one enormous line whole", () => {
    const md = "word ".repeat(30000) + "needle " + "word ".repeat(30000);
    expect(snippetAround(md, ["needle"])).toEqual(snippetAroundWholeNote(md, ["needle"]));
  });

  it("is the documented difference: a term split only by markup is not a match", () => {
    const md = "plain ".repeat(3000) + "kaf**ka** here " + "plain ".repeat(3000);
    expect(snippetAroundWholeNote(md, ["kafka"])).not.toBeNull();
    expect(snippetAround(md, ["kafka"])).toBeNull();
  });

  // The regression the report found: after V8 optimised the loop, the server
  // took ~19 s per search on 50 bodies read from node-postgres. Bodies go
  // through Buffer to be strings of the same kind; the bound is generous so CI
  // load can't fail it, and still far below the ~19 s per pass of the bug.
  it("stays fast over 50 long bodies decoded from a Buffer, run after run", { timeout: 30000 }, () => {
    const bodies = Array.from({ length: 50 }, (_, i) => {
      const para = "Some **bold** text with `code` and [[Link|alias]] words 中文字元 kafka\n\n## Heading\n";
      let md = `# Note ${i}\n`;
      while (md.length < 200_000) md += para;
      return Buffer.from(md + "needle tail", "utf8").toString("utf8");
    });
    const timings: string[] = [];
    let total = 0;
    for (let run = 1; run <= 3; run++) {
      const started = performance.now();
      for (const body of bodies) { snippetAround(body, ["kafka"]); snippetAround(body, ["needle"]); snippetAround(body, ["absent"]); }
      const ms = performance.now() - started;
      total += ms;
      timings.push(`${ms.toFixed(0)} ms`);
    }
    console.log(`snippetAround, 50 bodies x ~200 KB x 3 terms, runs: ${timings.join(", ")}`);
    expect(total).toBeLessThan(6000);
  });
});

describe("the app's marks are not words in a snippet or a summary", () => {
  const md = "# 作業\n\n- [ ] 15:00 作業二 {task} ^ffb6f7\n- [x] 讀書 {task, 考點} ^a1\n普通段落 ^p1\n見 [[筆記|別名]] {x}\n";
  it("snippets drop {task}, ^id and the task box", () => {
    const text = snippetAround(md, ["作業"])!.text;
    expect(text).toContain("15:00 作業二");
    for (const bad of ["{task}", "{", "^", "[[", "[ ]"]) expect(text, bad).not.toContain(bad);
    expect(snippetPlainText(md)).not.toMatch(/[{^]|\[\[|\[[ xX]\]/);
  });
  it("a backlink preview reads the words around the link", () => {
    const raw = "## 寫筆記\n筆記就是一頁 {task} ^zz9\n- [ ] 見 [[筆記|別名]] 之後 **粗**";
    const at = raw.indexOf("[[");
    const { text, range } = plainAroundSpan(raw, at, raw.indexOf("]]") + 2);
    expect(text).toBe("寫筆記 筆記就是一頁 見 別名 之後 粗");
    expect(text.slice(...range)).toBe("別名");
  });
});

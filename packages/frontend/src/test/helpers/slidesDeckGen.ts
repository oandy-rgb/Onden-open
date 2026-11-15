// Random note Markdown for the 「簡報」 view's page cutting (modules/slides/slides.ts parseDeck, pages.ts pagesOf).
// Shared by the property tests of the slide pages; the later tests of page edits (move, copy, delete, insert) build
// their decks from the same generator.
//
// A generated deck knows what it was built from, so a test compares the cut against the truth instead of a second
// parser: `pagesMd` is each page's Markdown (LF), `render()` puts the note together from them (so a test can edit one
// page and render again), and `shown(page)` lists the words of a page a reader sees.
//
// Words. Every word a block shows is a unique token `w<n>z` (the placeholder `§` while building); a word that is
// never drawn (an image's alt and address, an embed target, the frontmatter) is `h<n>z` (placeholder `¦`). A test
// finds out which words were lost or doubled by reading the tokens back, whatever the page does to the Markdown
// around them.
//
// Shapes of a deck (`DeckMode`):
//   rule  — pages split at lines of only `---` (any number in a row, with empty pages between, a trailing or leading
//           one, `---` followed by spaces); pages may hold `##` headings too, which then split nothing
//   h2    — no `---` line outside code at all: pages split at their `## ` headings; the part before the first `##`
//           is page 0 (a note with no `##` at all is a single page)
//   empty — "" or only whitespace
// Code blocks in any deck carry lines of `---`, `## x`, `# x`, `***` so a cut that reads code as prose shows up.
//
// What the generator keeps away from, because the note then means something else on purpose:
//   • a `---` line right under a paragraph line (Markdown's setext underline) — the separators sit between blank lines
//   • a last page made only of `[n] …` lines (the deck's source list)

import fc from "fast-check";

export type DeckMode = "rule" | "h2" | "empty";

export type DeckDoc = {
  mode: DeckMode;
  /** Each page's Markdown in order, without separators; every one holds at least one block. Page 0 of an `h2` deck may be "". */
  pagesMd: string[];
  /** `rule`: the text between page i and page i+1 (`seps[i]`, at least one `---` line), `seps.length === pagesMd.length - 1`. */
  seps: string[];
  /** `rule`: a separator line before the first page / after the last one. */
  leadSep: string;
  trailSep: string;
  /** Frontmatter at the very start ("" for none): its words are `h<n>z`. */
  front: string;
  /** Lines (by index) that get trailing spaces when the note is rendered. */
  spaced: number;
  /** The note as text, LF. `pagesMd` may be replaced (an edit) without changing anything else. */
  render: (pagesMd?: readonly string[], withFront?: boolean) => string;
};

// ---- blocks -----------------------------------------------------------------------------------------------------

type Block = { md: string; heading?: number };

const FILLER = ["§", "§", "§", "中文§", "😀§", "日本語", "한국어", "§,", "§。", "ｆｕｌｌ§", "é§", "👨‍👩‍👧§"];
const word = fc.constantFrom(...FILLER);
const words = (min: number, max: number) => fc.array(word, { minLength: min, maxLength: max }).map((w) => w.join(" "));

const INLINE = ["**§**", "*§*", "~~§~~", "`§`", "[[Note|§]]", "[§](https://example.com)", "[[§]]"];
const inlineWords = fc.array(fc.oneof({ weight: 4, arbitrary: word }, { weight: 1, arbitrary: fc.constantFrom(...INLINE) }), { minLength: 1, maxLength: 6 }).map((w) => w.join(" "));

const paragraph: fc.Arbitrary<Block> = fc.array(inlineWords, { minLength: 1, maxLength: 3 }).map((lines) => ({ md: lines.join("\n") }));
const longParagraph: fc.Arbitrary<Block> = fc.array(word, { minLength: 70, maxLength: 90 }).map((w) => ({ md: w.join(" ") }));

const heading = (levels: readonly number[]): fc.Arbitrary<Block> =>
  fc.tuple(fc.constantFrom(...levels), words(1, 4)).map(([level, text]) => ({ md: `${"#".repeat(level)} ${text}`, heading: level }));

const LEADS = ["", "", "", "2024 ", "90% ", "Q3 ", "12:30 ", "3 人 "];
const listItem = fc.tuple(fc.constantFrom(...LEADS), words(1, 3));
const list: fc.Arbitrary<Block> = fc
  .tuple(
    fc.constantFrom("bullet", "numbered", "task"),
    fc.array(fc.tuple(listItem, fc.option(listItem, { nil: undefined }), fc.boolean()), { minLength: 1, maxLength: 6 }),
  )
  .map(([kind, items]) => ({
    md: items
      .map(([[lead, text], child, ticked], i) => {
        const mark = kind === "numbered" ? `${i + 1}. ` : kind === "task" ? `- [${ticked ? "x" : " "}] ` : "- ";
        const nested = child ? `\n${kind === "numbered" ? "   " : "  "}- ${child[0]}${child[1]}` : "";
        return `${mark}${lead}${text}${nested}`;
      })
      .join("\n"),
  }));

const image: fc.Arbitrary<Block> = fc.constantFrom("![¦](https://example.com/¦.png)", "![¦](¦.jpg)", "![](assets/¦.png)").map((md) => ({ md }));
const embed: fc.Arbitrary<Block> = fc.constantFrom("![[¦]]", "![[¦#§]]").map((md) => ({ md }));

const CODE_LINES = ["const § = 1;", "---", "## §", "# §", "", "***", "```", "~~~", "    indented §", "- § ", "---  ", "[1] §"];
const code: fc.Arbitrary<Block> = fc
  .tuple(
    fc.constantFrom("```", "~~~", "````", "~~~~~"),
    fc.constantFrom("", "ts", "js title=§"),
    fc.array(fc.constantFrom(...CODE_LINES), { minLength: 1, maxLength: 7 }),
  )
  .map(([fence, lang, lines]) => {
    // A line that would close this fence is not code: keep the block closed in one place.
    const safe = lines.filter((l) => !(l.trim().startsWith(fence[0]!.repeat(fence.length)) && l.trim().length >= fence.length));
    return { md: `${fence}${lang}\n${safe.length ? safe.join("\n") : "§"}\n${fence}` };
  });

const MATH_HAZARD = ["---", "## §", "", "# §"];
const math = (hazards: boolean): fc.Arbitrary<Block> =>
  fc.array(fc.constantFrom("§ + §", "\\frac{§}{2}", "x^2", ...(hazards ? MATH_HAZARD : [])), { minLength: 1, maxLength: 5 }).map((lines) => ({ md: `$$\n${lines.join("\n")}\n$$` }));

const quote: fc.Arbitrary<Block> = fc.constantFrom("> §\n> §", "> [!note] §\n> §", "> § § §", "> > §").map((md) => ({ md }));
const table: fc.Arbitrary<Block> = fc
  .constantFrom("| § | § |\n| --- | --- |\n| § | § |", "§ | §\n--- | ---\n§ | §", "| § |\n|:--|\n| § |\n| § |")
  .map((md) => ({ md }));
/** `^id` at the end of a line: the legacy mark (a note's text no longer carries them, an old one may). */
const anchored: fc.Arbitrary<Block> = fc.constantFrom("§ § ^abc123", "- § ^item-1\n- §", "§\n^only-id").map((md) => ({ md }));

export type BlockOptions = {
  /** Level-2 headings may appear (not in an `h2` deck: they are page breaks there). */
  h2?: boolean;
  /** `$$` blocks may hold `---` / `## ` / blank lines (on unless a test turns it off). */
  mathHazards?: boolean;
  /** Paragraphs and lists that end in a legacy `^id`. */
  legacyIds?: boolean;
};

const blockOf = ({ h2 = true, mathHazards = true, legacyIds = false }: BlockOptions): fc.Arbitrary<Block> =>
  fc.oneof(
    { weight: 6, arbitrary: paragraph },
    { weight: 1, arbitrary: longParagraph },
    { weight: 3, arbitrary: heading(h2 ? [1, 2, 3, 4, 5, 6] : [1, 3, 4, 5, 6]) },
    { weight: 3, arbitrary: list },
    { weight: 1, arbitrary: image },
    { weight: 1, arbitrary: embed },
    { weight: 2, arbitrary: code },
    { weight: 1, arbitrary: math(mathHazards) },
    { weight: 1, arbitrary: quote },
    { weight: 1, arbitrary: table },
    ...(legacyIds ? [{ weight: 1, arbitrary: anchored }] : []),
  );

/** One page's content: 1–5 blocks, a heading often first. */
export const pageMd = (options: BlockOptions = {}): fc.Arbitrary<string> =>
  fc
    .tuple(fc.option(heading(options.h2 === false ? [1, 3, 4, 5, 6] : [1, 2, 3]), { nil: undefined, freq: 3 }), fc.array(blockOf(options), { minLength: 0, maxLength: 4 }))
    .filter(([head, rest]) => head !== undefined || rest.length > 0)
    .map(([head, rest]) => [...(head ? [head] : []), ...rest].map((b) => b.md).join("\n\n"));

// ---- a deck -----------------------------------------------------------------------------------------------------

const sepLine = fc.constantFrom("---", "---", "---", "---  ", "--- ", "---\t");
const separator: fc.Arbitrary<string> = fc
  .array(sepLine, { minLength: 1, maxLength: 3 })
  .map((lines) => `\n\n${lines.join("\n\n")}\n\n`);

/** Fills `§` and `¦` with `w<n>z` and `h<n>z` in order across `parts` (so every word of the deck is its own). */
export function numberWords(parts: readonly string[], start = 1): string[] {
  let n = start;
  return parts.map((part) => part.replace(/[§¦]/g, (mark) => `${mark === "§" ? "w" : "h"}${n++}z`));
}

const FRONT = ["---\n---\n\n", "---\n---\n", "---\ntitle: ¦\n---\n\n", "---\ntitle: ¦\ntags: [a, ¦]\n---\n", "---\naliases:\n  - ¦\n---\n\n"];

function build(mode: DeckMode, pages: string[], seps: string[], leadSep: string, trailSep: string, front: string, spaced: number): DeckDoc {
  // Words are numbered once, in reading order: the frontmatter's first, then each page's.
  const numbered = numberWords([front, ...pages]);
  const frontText = numbered[0]!;
  const pagesMd = numbered.slice(1);
  const render = (md: readonly string[] = pagesMd, withFront = true): string => {
    let text: string;
    if (mode === "empty") text = md.join("");
    else if (mode === "h2") text = md.filter((p, i) => i > 0 || p.trim()).join("\n\n");
    else text = leadSep + md.map((p, i) => p + (i < md.length - 1 ? (seps[i] ?? "\n\n---\n\n") : "")).join("") + trailSep;
    if (withFront) text = frontText + text;
    if (spaced <= 0) return text;
    return text.split("\n").map((line, i) => (line.trim() && i % spaced === 0 ? `${line}  ` : line)).join("\n");
  };
  return { mode, pagesMd, seps, leadSep, trailSep, front: frontText, spaced, render };
}

const frontOf = fc.option(fc.constantFrom(...FRONT), { nil: "", freq: 4 });
const spacedOf = fc.constantFrom(0, 0, 0, 2, 3, 5);

const ruleDeck = (options: BlockOptions, maxPages: number): fc.Arbitrary<DeckDoc> =>
  fc
    .tuple(
      fc.array(pageMd({ ...options, h2: options.h2 ?? true }), { minLength: 1, maxLength: Math.max(1, maxPages) }),
      fc.array(separator, { minLength: 12, maxLength: 12 }),
      fc.constantFrom("\n\n---\n", "\n\n---  \n\n---\n", "\n\n\n---", ""),
      fc.boolean(),
      frontOf,
      spacedOf,
    )
    .map(([pages, seps, trail, lead, front, spaced]) => {
      if (pages.length > 1) return build("rule", pages, seps.slice(0, pages.length - 1), "", trail, front, spaced);
      // One page needs a `---` line to be a rule deck (else its `##` headings cut it).
      return lead ? build("rule", pages, [], "---\n\n", "", front, spaced) : build("rule", pages, [], "", trail || "\n\n---\n", front, spaced);
    });

const h2Deck = (options: BlockOptions, maxPages: number): fc.Arbitrary<DeckDoc> =>
  fc
    .tuple(
      fc.option(pageMd({ ...options, h2: false }), { nil: "", freq: 2 }),
      fc.array(fc.tuple(words(1, 3), fc.option(pageMd({ ...options, h2: false }), { nil: "" })), { minLength: 0, maxLength: Math.max(0, maxPages - 1) }),
      frontOf,
      spacedOf,
    )
    .filter(([lead, rest]) => lead.trim() !== "" || rest.length > 0)
    .map(([lead, rest, front, spaced]) => {
      const pages = [lead, ...rest.map(([title, body]) => `## ${title}${body ? `\n\n${body}` : ""}`)];
      return build("h2", pages, [], "", "", front, spaced);
    });

/** 0–`maxPages` pages in any of the shapes above. */
export const deckDoc = (options: BlockOptions & { maxPages?: number } = {}): fc.Arbitrary<DeckDoc> => {
  const maxPages = options.maxPages ?? 12;
  return fc.oneof(
    { weight: 6, arbitrary: ruleDeck(options, maxPages) },
    { weight: 4, arbitrary: h2Deck(options, maxPages) },
    { weight: 1, arbitrary: fc.constantFrom("", " ", "\n", "\n\n  \n", "\t").map((text) => build("empty", [text], [], "", "", "", 0)) },
  );
};

// ---- reading a cut back -----------------------------------------------------------------------------------------

/** The visible-word tokens (`w<n>z`) in `text`, in order. */
export const shownWords = (text: string): string[] => text.match(/w\d+z/g) ?? [];
/** The hidden-word tokens (`h<n>z`) in `text`. */
export const hiddenWords = (text: string): string[] => text.match(/h\d+z/g) ?? [];
/** `text` without whitespace, as characters: the comparison that ignores line endings, trailing spaces and blank lines. */
export const solid = (text: string): string => text.replace(/\s/gu, "");
export const asCrlf = (text: string): string => text.replace(/\n/g, "\r\n");

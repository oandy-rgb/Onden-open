// What the metamorphic search tests share (helpers/metamorphic.ts is the runner): the generated corpus, the
// engine-neutral world a test hands the relations, and the relations themselves.
//
//   MR-S1  a shorter query finds at least what the longer one found (walk every prefix, full fragment → 1 grapheme)
//   MR-S2  a one-grapheme query's answer depends on what the text holds, not on which class the grapheme is in
//   MR-S3  typo-tolerant rows appear only when there is no exact row
//
// A test supplies an `open(notes)` for its engine; the world answers `search(query)` with rows that say which
// note they are (an index into the corpus, not an id) and which source they came from, so only EXACT rows
// are compared: the app's one search appends typo-tolerant and meaning rows to the exact ones.
//
// Characters are counted in graphemes (Intl.Segmenter), never UTF-16 units or code points: "one character"
// and "length 2" disagree for exactly the classes the palette below is made of.

import fc from "fast-check";
import { normalizeText } from "../../word.js";
import { SKIP, type Skip } from "./metamorphic.js";

// ── graphemes ────────────────────────────────────────────────────────────────

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemesOf = (text: string): string[] => [...segmenter.segment(text)].map((part) => part.segment);

/** One entry per class the one-grapheme step must cover. Each entry is ONE grapheme (checked below); the
 *  `lengths` the engines see are in the comment. */
const PALETTE = {
  /** BMP Han: length 1. */
  han: ["筆", "記", "日", "本", "書", "館", "咖", "啡"],
  /** CJK Extension B: a surrogate pair, length 2. */
  hanExtB: ["\u{20000}", "\u{20021}", "\u{2A6D6}", "\u{24BEE}", "\u{25257}"],
  /** Emoji: a surrogate pair (length 2) or a BMP one (length 1). */
  emoji: ["😀", "🎉", "🔥", "⭐", "✅"],
  /** ZWJ emoji sequences: one grapheme, length 5–8. */
  zwj: ["👨‍👩‍👧", "🧑‍💻", "🏳️‍🌈"],
  /** Latin letter plus a combining accent (NFD): one grapheme, length 2. */
  nfd: ["é", "ä", "ñ", "ô"],
  /** The same letters precomposed (NFC): length 1. */
  nfc: ["é", "ä", "ñ", "ô"],
  /** Hangul syllables: length 1. */
  hangul: ["한", "글", "가", "힣"],
  /** 注音 symbols and their tone marks (a tone mark is its own grapheme): length 1. */
  bopomofo: ["ㄅ", "ㄚ", "ㄊ", "ˊ", "ˇ", "ˋ", "˙"],
  /** Plain Latin letters and digits. */
  latin: ["a", "e", "k", "n", "o", "t", "r", "s", "1", "7"],
} as const;
export type GraphemeClass = keyof typeof PALETTE;
/** The classes whose graphemes have both an NFC and an NFD spelling (a Hangul syllable decomposes into jamo). */
export const SPELLED_TWO_WAYS: readonly GraphemeClass[] = ["nfd", "nfc", "hangul"];
export const GRAPHEME_CLASSES = Object.keys(PALETTE) as GraphemeClass[];

/** Graphemes the corpus never contains, so a swap (MR-S2) cannot collide with the text. One per class. */
const RESERVE: Record<GraphemeClass, string> = {
  han: "嗨", hanExtB: "\u{2000B}", emoji: "🦄", zwj: "👩‍🔬", nfd: "ü", nfc: "ü", hangul: "뷁", bopomofo: "ㄗ", latin: "q",
};

for (const [name, list] of [...Object.entries(PALETTE), ["reserve", Object.values(RESERVE)] as const]) {
  for (const entry of list) {
    if (graphemesOf(entry).length !== 1) throw new Error(`searchMetamorphic: ${name} entry ${JSON.stringify(entry)} is not one grapheme`);
  }
}

const classOfGrapheme = new Map<string, GraphemeClass>(GRAPHEME_CLASSES.flatMap((name) => PALETTE[name].map((g): [string, GraphemeClass] => [g, name])));
for (const [name, g] of Object.entries(RESERVE)) classOfGrapheme.set(g, name as GraphemeClass);
/** Which palette class a grapheme belongs to ("other" when it is not one of ours). */
export const classOf = (grapheme: string): GraphemeClass | "other" => classOfGrapheme.get(grapheme) ?? "other";

// ── the corpus ───────────────────────────────────────────────────────────────

export type SearchNote = { title: string; body: string };
export type Home = { note: number; field: "title" | "body" };
export type PrefixCase = {
  /** The notes as the server stores them (titles in NFC, as noteCreate does). */
  notes: SearchNote[];
  /** ≥ 3 graphemes, taken from `home`; no query-syntax character, no whitespace. */
  fragment: string[];
  home: Home;
  /** A grapheme of another class than the fragment's first one, absent from the corpus (MR-S2). */
  swap: string;
};

/** Query syntax in the fragment is never generated (the palette holds none, and the checks below say so):
 *  `#tag`, `key:value`, `"phrase"`, a leading `-`, the `OR` word, whitespace between words, and pgroonga's
 *  own `( ) * ~ < > + \`. See @onden/markdown parseSearchQuery and the portable engine's parsePortableQuery. */
export const QUERY_SYNTAX = /["#:\-\s()*~<>+\\]/;
export const isPlainText = (fragment: string[]): boolean => {
  const text = fragment.join("");
  return !QUERY_SYNTAX.test(text) && !/^or/i.test(text);
};

const anyGrapheme = fc.constantFrom<string[]>(...GRAPHEME_CLASSES.flatMap((name): string[] => [...PALETTE[name]]));
const ofClass = (name: GraphemeClass) => fc.constantFrom<string[]>(...PALETTE[name]);

export type CorpusOptions = {
  /** Relative weight of each class as the class of the fragment; the default is even. */
  classWeights?: Partial<Record<GraphemeClass, number>>;
  /** The classes the swap grapheme (MR-S2) may come from; the default is all of them. */
  swapFrom?: readonly GraphemeClass[];
};

/** Tokens that make up a text: graphemes, with spaces (and in a body, line breaks) between. */
const filler = (maxTokens: number, lineBreaks: boolean) => fc.array(
  fc.oneof({ weight: 8, arbitrary: anyGrapheme }, { weight: 2, arbitrary: fc.constant(" ") }, { weight: lineBreaks ? 1 : 0, arbitrary: fc.constant("\n") }),
  { maxLength: maxTokens },
);

export function prefixCases(options: CorpusOptions = {}): fc.Arbitrary<PrefixCase> {
  const weights = options.classWeights ?? {};
  const classArb = fc.oneof(...GRAPHEME_CLASSES.map((name) => ({ weight: weights[name] ?? 1, arbitrary: fc.constant(name) })));
  const fragmentArb = classArb.chain((name) => fc.array(
    fc.oneof({ weight: 5, arbitrary: ofClass(name) }, { weight: 1, arbitrary: anyGrapheme }), { minLength: 3, maxLength: 6 },
  ).filter(isPlainText).map((fragment) => ({ name, fragment })));
  // FEWER notes than the result limit (30), so the limit cannot truncate: its own behaviour has its own test.
  const noteArb = fc.record({
    // A title is never empty (the REST API refuses one).
    title: fc.tuple(anyGrapheme, filler(4, false)).map(([first, rest]) => [first, ...rest]), body: filler(12, true),
    // Some notes carry the first `plant` graphemes of the fragment (in the title or the body): a shorter query
    // then has something the longer one lacks, which is what the relation is about.
    plant: fc.option(fc.record({ length: fc.integer({ min: 1, max: 5 }), field: fc.constantFrom<"title" | "body">("title", "body"), at: fc.nat(12) }), { nil: undefined }),
  });
  return fc.record({
    picked: fragmentArb,
    notes: fc.array(noteArb, { minLength: 2, maxLength: 6 }),
    homeNote: fc.nat(5), homeField: fc.constantFrom<"title" | "body">("title", "body"), homeAt: fc.nat(12),
    swapClass: fc.constantFrom(...(options.swapFrom ?? GRAPHEME_CLASSES)),
  }).map(({ picked, notes, homeNote, homeField, homeAt, swapClass }): PrefixCase => {
    const { fragment } = picked;
    // A title is stored in NFC, so a decomposed fragment can only be taken from a body.
    const decomposed = fragment.join("") !== normalizeText(fragment.join(""));
    const home: Home = { note: homeNote % notes.length, field: decomposed ? "body" : homeField };
    const insert = (tokens: string[], piece: string[], at: number) => { const copy = [...tokens]; copy.splice(at % (copy.length + 1), 0, ...piece); return copy; };
    const built = notes.map((note, index): SearchNote => {
      let title = note.title, body = note.body;
      if (note.plant && !(decomposed && note.plant.field === "title")) {
        const piece = fragment.slice(0, Math.min(note.plant.length, fragment.length - 1));
        if (note.plant.field === "title") title = insert(title, piece, note.plant.at); else body = insert(body, piece, note.plant.at);
      }
      if (index === home.note) { if (home.field === "title") title = insert(title, fragment, homeAt); else body = insert(body, fragment, homeAt); }
      return { title: normalizeText(title.join("")), body: body.join("") };
    });
    const firstClass = classOf(fragment[0]!);
    const pool = options.swapFrom ?? GRAPHEME_CLASSES;
    const swapFrom = swapClass === firstClass ? pool[(pool.indexOf(swapClass) + 1) % pool.length]! : swapClass;
    return { notes: built, fragment, home, swap: RESERVE[swapFrom] };
  });
}

// ── what a test hands the relations ──────────────────────────────────────────

export type RowSource = "server" | "local" | "fuzzy" | "semantic";
/** `index` names the note in the corpus the world was opened with. */
export type FoundRow = { index: number; source: RowSource };
export type SearchWorld = { search(query: string): Promise<FoundRow[]> };

/** The rows that come from an exact source (the typo-tolerant and meaning rows are not what a prefix relation is about). */
export const exactIndices = (rows: FoundRow[]): Set<number> => new Set(rows.filter((row) => row.source === "server" || row.source === "local").map((row) => row.index));

// ── coverage: what the runs really compared ─────────────────────────────────

export type Coverage = {
  /** Relation runs that walked down to the one-grapheme query. */
  oneGraphemeQueries: number;
  /** …whose corpus had a note holding the grapheme in its BODY only, so only a body match can find it. */
  bodyOnlyExpected: number;
  /** …of which the one-grapheme query found that note. */
  bodyOnlyFound: number;
  /** One-grapheme queries per class of the grapheme and, for the "length 2" classes, how many UTF-16 units it is. */
  byClass: Record<string, number>;
};
export const newCoverage = (): Coverage => ({ oneGraphemeQueries: 0, bodyOnlyExpected: 0, bodyOnlyFound: 0, byClass: {} });
export const describeCoverage = (coverage: Coverage): string =>
  `[coverage] one-grapheme queries ${coverage.oneGraphemeQueries}; with a body-only note in the corpus ${coverage.bodyOnlyExpected}, found ${coverage.bodyOnlyFound}; by class ${JSON.stringify(coverage.byClass)}`;

// ── relations ────────────────────────────────────────────────────────────────

export type PrefixOptions = {
  /** A reason to skip this case (the engine cannot be asked this prefix), or null. Asked of every prefix in the walk. */
  untypable?: (prefix: string, homeText: string) => string | null;
  /** A named reason the engine is known to find nothing for this fragment (so a walk down from nothing proves nothing),
   *  or null: then "the whole fragment found nothing" is the generic reason and is counted on its own. */
  whyNothing?: (fragment: string) => string | null;
  coverage?: Coverage;
};

const homeTextOf = (input: PrefixCase): string => input.notes[input.home.note]![input.home.field];
/** A text with every non-ASCII code point spelled out: NFC and NFD look the same on screen and are not the same query. */
export const spelled = (text: string): string => [...text].map((c) => (c.codePointAt(0)! < 0x80 ? c : `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`)).join("");
const show = (text: string): string => `${JSON.stringify(text)} = ${spelled(text)} (${graphemesOf(text).length} graphemes, ${text.length} UTF-16 units)`;

/** MR-S1: walk every prefix from the whole fragment down to ONE grapheme; the exact rows of prefix k must
 *  contain the exact rows of prefix k+1. */
export async function shorterFindsAtLeastWhatLongerFound(world: SearchWorld, input: PrefixCase, options: PrefixOptions = {}): Promise<null | string | Skip> {
  const prefixes = input.fragment.map((_, at) => input.fragment.slice(0, at + 1).join("")).reverse();
  const homeText = homeTextOf(input);
  for (const prefix of prefixes) {
    const why = options.untypable?.(prefix, homeText);
    if (why) return SKIP(why);
  }
  let longer: Set<number> | null = null;
  let longerPrefix = "";
  for (const prefix of prefixes) {
    const found = exactIndices(await world.search(prefix));
    if (longer === null) {
      if (found.size === 0) return SKIP(options.whyNothing?.(prefix) ?? "the whole fragment found nothing");
    } else {
      for (const index of longer) {
        if (!found.has(index)) return `the query ${show(prefix)} lacks note #${index} that the longer query ${show(longerPrefix)} found (a prefix of ${graphemesOf(prefix).length} graphemes lost it)`;
      }
    }
    longer = found;
    longerPrefix = prefix;
  }
  const coverage = options.coverage;
  if (coverage && longer) {
    const g = input.fragment[0]!;
    const bodyOnly = input.notes.flatMap((note, index) => (note.body.includes(g) && !note.title.includes(g) ? [index] : []));
    coverage.oneGraphemeQueries++;
    coverage.byClass[`${classOf(g)}/${g.length}u`] = (coverage.byClass[`${classOf(g)}/${g.length}u`] ?? 0) + 1;
    if (bodyOnly.length > 0) { coverage.bodyOnlyExpected++; if (bodyOnly.every((index) => longer.has(index))) coverage.bodyOnlyFound++; }
  }
  return null;
}

/** The corpus with the fragment's first grapheme replaced by `swap` in every text (what MR-S2 compares against). */
export const withSwap = (notes: SearchNote[], from: string, to: string): SearchNote[] =>
  notes.map((note) => ({ title: normalizeText(note.title.replaceAll(from, to)), body: note.body.replaceAll(from, to) }));

/** MR-S2: the world holds the corpus TWICE — the original (indices 0..n-1) and the one with the grapheme swapped
 *  (indices n..2n-1). Asking for the grapheme in the first and its replacement in the second must find the same notes. */
export async function oneGraphemeIgnoresItsClass(world: SearchWorld, input: PrefixCase, options: { untypable?: (grapheme: string) => string | null } = {}): Promise<null | string | Skip> {
  const original = input.fragment[0]!;
  const n = input.notes.length;
  if (input.notes.some((note) => note.title.includes(input.swap) || note.body.includes(input.swap) || input.swap.includes(original) || original.includes(input.swap))) return SKIP("the swap grapheme is already in the corpus");
  for (const grapheme of [original, input.swap]) {
    const why = options.untypable?.(grapheme);
    if (why) return SKIP(why);
  }
  const first = exactIndices(await world.search(original));
  const second = exactIndices(await world.search(input.swap));
  const before = [...first].filter((index) => index < n).sort((a, b) => a - b);
  const after = [...second].filter((index) => index >= n).map((index) => index - n).sort((a, b) => a - b);
  if (before.length === 0 && after.length === 0) return SKIP("neither grapheme was found");
  if (before.join() !== after.join()) {
    return `${show(original)} (${classOf(original)}) finds notes [${before}] but ${show(input.swap)} (${classOf(input.swap)}) in the same corpus with it swapped in finds [${after}]`;
  }
  return null;
}

/** MR-S3: for every prefix, typo-tolerant rows appear only when there is no exact row. */
export async function fuzzyOnlyWithoutExact(world: SearchWorld, input: PrefixCase): Promise<null | string> {
  for (let length = input.fragment.length; length >= 1; length--) {
    const prefix = input.fragment.slice(0, length).join("");
    const rows = await world.search(prefix);
    const fuzzy = rows.filter((row) => row.source === "fuzzy");
    if (fuzzy.length > 0 && exactIndices(rows).size > 0) return `the query ${show(prefix)} got typo-tolerant rows [${fuzzy.map((row) => row.index)}] next to exact rows [${[...exactIndices(rows)]}]`;
  }
  return null;
}

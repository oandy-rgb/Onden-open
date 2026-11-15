// Generators of "Chinese and Unicode text" for the randomized property tests.
// One set for all three packages: the backend and the frontend import it by
// path (as they do htmlHazards.ts and linearTiming.testing.ts), so every layer
// is tried with the same awkward text. Seed and run count come from
// PROPS_SEED / PROPS_RUNS (propsConfig.ts); see docs/agents/testing.md
// "中文與 Unicode".
//
// Weighted on purpose: ordinary Traditional Chinese and Latin text is most of
// what is generated (so a property still exercises the normal path), the odd
// pieces — surrogate pairs, ZWJ sequences, combining marks, invisible
// characters, CRLF — are rare per piece but present in nearly every string of
// a few pieces. Replay a failure with the seed fast-check prints.

import fc from "fast-check";

/** Everyday Traditional Chinese characters (the bulk of the text). */
const COMMON_HANT = [..."的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很業最間新什笑筆記標題搜尋預覽網站發布匯出匯入暫存專案資料夾白板任務復原權限同步離線"];
/** Rarer BMP characters (rare surnames, old forms). */
const RARE_BMP = [..."龘鱻麤靐齉爨籲饕餮鬱驫犇淼焱曌嬲彧堃皞燚"];
/** CJK Extension B–G: each is a surrogate pair in UTF-16. */
const EXT_CJK = ["𠀀", "𠮷", "𡃁", "𢫦", "𣎴", "𤋮", "𥉉", "𦫿", "𧃒", "𨋢", "𩸽", "𪚥", "𫝆", "𬺓", "𭕄", "𰻞", "𠂇", "𡋗"];
const FULLWIDTH_PUNCT = [..."「」『』（）［］【】、。，；：？！…—～《》〈〉〔〕·‧"];
const FULLWIDTH_ALNUM = [..."ＡＢＣｘｙｚａｂｃ０１２３４５６７８９＃＊＿［］｛｝＠"];
const IDEOGRAPHIC_SPACE = "　";
const BOPOMOFO = [..."ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙㄧㄨㄩㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦˊˇˋ˙"];
const EMOJI = ["😀", "🎉", "📝", "🔥", "👍", "❤", "✅", "🌏", "𝒜", "🧪"];
const EMOJI_COMPLEX = [
  "👩‍👩‍👧‍👦", "👨‍👩‍👧", "🏳️‍🌈", "👩🏽‍💻", // ZWJ sequences
  "🇹🇼", "🇯🇵", "🇺🇸", // flags (two regional indicators)
  "👍🏽", "👋🏻", // skin tone modifiers
  "❤️", "☺️", "✌️", "1️⃣", // variation selector 16 / keycap
];
/** A base letter plus combining marks: NFD-looking text that NFC composes. */
const NFD_PIECES = ["é", "ñ", "ö", "ü", "Å", "ệ", "가", "ガ", "パ", "ǖ"];
const NFC_TWINS = ["é", "ñ", "ö", "ü", "Å", "ệ", "가", "ガ", "パ", "ǖ"];
const COMBINING = ["́", "̀", "̈", "̃", "⃣", "ㆍ"];
const INVISIBLE = ["​", "‌", "‍", "﻿", "⁠", "­", "‎", "‏"];
const SPACES = [" ", " ", "\t", " ", "　"];
const LINE_BREAKS = ["\n", "\r\n", "\r", " ", " "];
const LATIN = [..."abcdefghijklmnopqrstuvwxyzABCXYZ0123456789"];
const MARKDOWN_BITS = ["**", "*", "`", "[[", "]]", "#", "> ", "- ", "- [ ] ", "|", "$", "~~", "==", "_", "[", "](", ")", "!["];

const pick = (list: readonly string[]) => fc.constantFrom(...list);

/** One piece of text, weighted: common Chinese ≫ Latin/digits ≫ the rest. */
export const textPiece: fc.Arbitrary<string> = fc.oneof(
  { weight: 40, arbitrary: pick(COMMON_HANT) },
  { weight: 12, arbitrary: pick(LATIN) },
  { weight: 8, arbitrary: pick(FULLWIDTH_PUNCT) },
  { weight: 5, arbitrary: pick(SPACES) },
  { weight: 4, arbitrary: pick(FULLWIDTH_ALNUM) },
  { weight: 3, arbitrary: pick(EXT_CJK) },
  { weight: 3, arbitrary: pick(EMOJI) },
  { weight: 3, arbitrary: pick(EMOJI_COMPLEX) },
  { weight: 2, arbitrary: pick(RARE_BMP) },
  { weight: 2, arbitrary: pick(BOPOMOFO) },
  { weight: 2, arbitrary: pick(NFD_PIECES).map((c) => c.normalize("NFD")) },
  { weight: 2, arbitrary: pick(NFC_TWINS) },
  { weight: 2, arbitrary: pick(INVISIBLE) },
  { weight: 1, arbitrary: pick(COMBINING) },
);

const join = (parts: string[]) => parts.join("");

/** Free text of up to `max` pieces; no line breaks. */
export function unicodeText(opts: { minLength?: number; maxLength?: number } = {}): fc.Arbitrary<string> {
  return fc.array(textPiece, { minLength: opts.minLength ?? 0, maxLength: opts.maxLength ?? 24 }).map(join);
}

/** Free text with line breaks (\n, \r\n, bare \r) between pieces. */
export function unicodeMultiline(opts: { maxLength?: number } = {}): fc.Arbitrary<string> {
  return fc.array(
    fc.oneof({ weight: 10, arbitrary: textPiece }, { weight: 1, arbitrary: pick(LINE_BREAKS) }),
    { maxLength: opts.maxLength ?? 40 },
  ).map(join);
}

/** Text interleaved with Markdown syntax fragments (`**`, `[[`, `#`, `|`, `$` …). */
export function markdownText(opts: { maxLength?: number } = {}): fc.Arbitrary<string> {
  return fc.array(
    fc.oneof(
      { weight: 8, arbitrary: textPiece },
      { weight: 3, arbitrary: pick(MARKDOWN_BITS) },
      { weight: 1, arbitrary: pick(["\n", "\n\n"]) },
    ),
    { maxLength: opts.maxLength ?? 30 },
  ).map(join);
}

/** A title as a person types it: visible text, no line breaks, trimmed, not
 *  empty, with at least one letter/digit/ideograph so a slug has something. */
export const titleText: fc.Arbitrary<string> = fc
  .array(textPiece, { minLength: 1, maxLength: 14 })
  .map((p) => join(p).replace(/[\r\n]+/g, " ").trim())
  .filter((t) => /[\p{L}\p{N}]/u.test(t));

/** Pieces that never carry Markdown meaning or odd whitespace: words to wrap
 *  in syntax under test. */
export const plainWord: fc.Arbitrary<string> = fc
  .array(fc.oneof(
    { weight: 30, arbitrary: pick(COMMON_HANT) },
    { weight: 6, arbitrary: pick(LATIN) },
    { weight: 2, arbitrary: pick(EXT_CJK) },
    { weight: 2, arbitrary: pick(EMOJI) },
    { weight: 1, arbitrary: pick(EMOJI_COMPLEX) },
  ), { minLength: 1, maxLength: 5 })
  .map(join);

export const FULLWIDTH_PUNCTUATION: readonly string[] = FULLWIDTH_PUNCT;
export const fullwidthPunct: fc.Arbitrary<string> = pick(FULLWIDTH_PUNCT);
export const invisibleChar: fc.Arbitrary<string> = pick(INVISIBLE);

/** The grapheme clusters of a string (the unit a person counts, moves over
 *  and deletes by). */
export function graphemesOf(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
}

/** Whether `text` holds a lone (unpaired) surrogate, i.e. would encode to U+FFFD. */
export const hasLoneSurrogate = (text: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

// ── Shared search corpus ─────────────────────────────────────────────────────
// The same notes and queries for every search layer (the server's PGroonga, the
// app's on-device index), fixed by the seed, so each layer is held to the same
// reference answer (searchFold).

/** The text search compares: width-folded (NFKC) and lower-cased, as PGroonga's
 *  normalizer folds it and as @onden/markdown snippet.ts folds it. */
export const searchFold = (text: string): string => text.normalize("NFKC").toLowerCase();

/** `size` notes — a title and a one-line body — from the generators, fixed by `seed`. */
export function searchCorpus(size: number, seed: number): Array<{ title: string; body: string }> {
  return fc.sample(
    fc.record({ title: titleText, body: unicodeText({ minLength: 4, maxLength: 60 }) }),
    { seed, numRuns: size },
  ).map((n) => ({ title: n.title.normalize("NFC"), body: n.body.replace(/[\r\n]+/g, " ") }));
}

/** A run of `length` whole grapheme clusters of `text` from cluster `from`
 *  (wrapping), trimmed: what a person types when looking for part of a title. */
export function pieceOf(text: string, from: number, length: number): string {
  const parts = graphemesOf(text);
  const start = from % Math.max(1, parts.length);
  return parts.slice(start, start + length).join("").trim();
}

/** Full-width forms of the ASCII letters, digits and punctuation (Ａ １ ＃), as a Chinese IME types them. */
export const toFullwidth = (text: string): string => text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

// ── Titles that are hard on file names and links ─────────────────────────────

const FILE_HOSTILE = ["<", ">", ":", '"', "/", "\\", "|", "?", "*", ".", "..", " ", "　", "#", "[", "]", "^", "%", "&", "'", "~", "(", ")", "（", "）", "「", "」", "CON", "NUL", "aux", "COM1"];

/** A title that stresses file names, URLs and links: Windows-forbidden characters,
 *  dots and blanks at the ends, reserved device names, full-width brackets
 *  (balanced or not: "_Inbox（暫存" has no closing bracket on purpose), plus the
 *  usual Chinese and Unicode text. One title in six is long enough to pass 255
 *  UTF-8 bytes (the limit of one file name on most disks). */
export const hostileTitle: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(fc.oneof({ weight: 6, arbitrary: textPiece }, { weight: 3, arbitrary: pick(FILE_HOSTILE) }), { minLength: 1, maxLength: 40 }),
    // One title in six is long: 60–180 more ordinary characters, 3 bytes each.
    fc.option(fc.integer({ min: 60, max: 180 }), { freq: 6 }),
  )
  .map(([pieces, extra]) => join(pieces).replace(/[\r\n]+/g, " ") + (extra === null ? "" : "筆記資料".repeat(Math.ceil(extra / 4)).slice(0, extra)))
  .filter((t) => /[\p{L}\p{N}]/u.test(t) && t.trim() === t && !/^[.\-#]/.test(t));

/** A body of lines of prose (no Markdown structure of its own), joined by \n or \r\n. */
export const proseBody: fc.Arbitrary<string> = fc
  .array(fc.array(fc.oneof({ weight: 8, arbitrary: plainWord }, { weight: 2, arbitrary: pick(FULLWIDTH_PUNCT) }, { weight: 1, arbitrary: pick(SPACES) }), { minLength: 1, maxLength: 8 }).map(join), { minLength: 1, maxLength: 4 })
  .map((lines) => lines.map((l) => l.trim()).filter(Boolean))
  .filter((lines) => lines.length > 0 && lines.every((l) => !/^[#>\-+*|\d]/.test(l) && !/^(?:[-*_]\s*){3,}$/.test(l)))
  .chain((lines) => fc.constantFrom("\n\n", "\r\n\r\n").map((sep) => lines.join(sep)));

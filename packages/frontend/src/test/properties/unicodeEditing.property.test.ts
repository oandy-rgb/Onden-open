// Property: the editor reads, shows and edits Chinese and Unicode text by
// grapheme cluster — what a person counts as one character. Moving the cursor
// and deleting step over a whole "👩‍👩‍👧‍👦", a flag, an accented letter typed as
// base + mark, a CJK extension character; the document the editor holds is the
// text it was given (line breaks aside); the word count counts every Chinese
// character, rare ones included, and no invisible character. Generators:
// markdown/src/test/helpers/unicodeText.ts. Seed and run count from
// PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { deleteCharBackward } from "@codemirror/commands";
import { cursorClusterLeft as cursorCharLeft, cursorClusterRight as cursorCharRight, deleteClusterForward as deleteCharForward } from "../../lib/editorCharKeys";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { cjkEmphasis } from "../../lib/editorCjkEmphasis";
import { countWords } from "@onden/markdown";
import { detectPopupTrigger } from "../../lib/editorCompletion";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { unicodeText, unicodeMultiline, markdownText, graphemesOf, plainWord } from "../../../../markdown/src/test/helpers/unicodeText";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
// A long run (PROPS_RUNS=5000) takes longer than the default 5 s a test gets.
const TIMEOUT = 15 * 60_000;

// jsdom has no layout; CodeMirror's measure pass needs these on Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const boundaries = (text: string) => graphemesOf(text).reduce<number[]>((ends, g) => [...ends, ends[ends.length - 1]! + g.length], [0]);

function view(doc: string, anchor: number): EditorView {
  return new EditorView({ state: EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage, extensions: [cjkEmphasis] })] }), parent: document.body });
}

describe("the editor's document", () => {
  it("holds the text it was given; only line breaks are normalised (CRLF and a bare CR become LF)", () => {
    fc.assert(fc.property(fc.oneof(unicodeText({ maxLength: 40 }), unicodeMultiline(), markdownText()), (text) => {
      const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage, extensions: [cjkEmphasis] })] });
      expect(state.doc.toString()).toBe(text.replace(/\r\n?/g, "\n"));
    }), fcOpts);
  });

  it("a typed insert lands exactly where the cursor is, whatever the text around it", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 30 }).map((t) => t.replace(/[\r\n]/g, "")), unicodeText({ minLength: 1, maxLength: 6 }).map((t) => t.replace(/[\r\n]/g, "")), fc.nat(40), (doc, insert, at) => {
      const pos = boundaries(doc)[at % boundaries(doc).length]!;
      const next = EditorState.create({ doc }).update({ changes: { from: pos, insert } }).state;
      expect(next.doc.toString()).toBe(doc.slice(0, pos) + insert + doc.slice(pos));
    }), fcOpts);
  });
});

// Decomposed Hangul (jamo, as a macOS file name has it) is the one text CodeMirror
// steps through jamo by jamo; lib/editorCharKeys steps over it whole.
const jamo = /[\u1100-\u11ff]/;
// A zero-width joiner that does not join two emoji (pasted from Word or a web page): CodeMirror glues it to the
// next character, so stock cursor and Delete would skip it and remove that character too; lib/editorCharKeys does not.
// A combining mark or joiner right after a control character (tab, ZWSP, BOM, LRM…) is not text anyone writes; Intl.Segmenter and
// CodeMirror differ on which cluster owns it.
const markAfterControl = /[\p{Cc}\p{Cf}][\p{M}\u200c\u200d]/u;
const strayJoiner = /(?<!\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)\u200d|\u200d(?!\p{Extended_Pictographic})/u;

describe("cursor movement and deletion step by grapheme cluster", () => {
  const oneLine = unicodeText({ minLength: 1, maxLength: 24 }).map((t) => t.replace(/[\r\n]/g, "")).filter((t) => !jamo.test(t) && !strayJoiner.test(t) && !markAfterControl.test(t));

  it("cursorCharRight / cursorCharLeft move to the next / previous cluster boundary", () => {
    fc.assert(fc.property(oneLine, fc.nat(60), (doc, k) => {
      const ends = boundaries(doc);
      const i = k % ends.length;
      const right = view(doc, ends[i]!);
      cursorCharRight(right);
      expect(right.state.selection.main.head, `right from ${ends[i]} in ${JSON.stringify(doc)}`).toBe(ends[Math.min(i + 1, ends.length - 1)]);
      right.destroy();
      const left = view(doc, ends[i]!);
      cursorCharLeft(left);
      expect(left.state.selection.main.head, `left from ${ends[i]} in ${JSON.stringify(doc)}`).toBe(ends[Math.max(i - 1, 0)]);
      left.destroy();
    }), fcOpts);
  }, TIMEOUT);

  it("deleteCharForward removes exactly the cluster after the cursor", () => {
    fc.assert(fc.property(oneLine, fc.nat(60), (doc, k) => {
      const ends = boundaries(doc);
      const i = k % (ends.length - 1 || 1);
      fc.pre(ends.length > 1);
      const v = view(doc, ends[i]!);
      deleteCharForward(v);
      expect(v.state.doc.toString(), `forward at ${ends[i]} in ${JSON.stringify(doc)}`).toBe(doc.slice(0, ends[i]) + doc.slice(ends[i + 1]));
      v.destroy();
    }), fcOpts);
  }, TIMEOUT);

  it("deleteCharBackward removes a whole cluster, or only the accent / mark that ends it (never half a pair, never into the cluster before)", () => {
    fc.assert(fc.property(oneLine, fc.nat(60), (doc, k) => {
      const ends = boundaries(doc);
      fc.pre(ends.length > 1);
      const i = 1 + (k % (ends.length - 1));
      const v = view(doc, ends[i]!);
      deleteCharBackward(v);
      const after = v.state.doc.toString();
      v.destroy();
      const removed = doc.slice(0, ends[i]).length - after.slice(0, after.length - (doc.length - ends[i]!)).length;
      expect(removed, `backward at ${ends[i]} in ${JSON.stringify(doc)}`).toBeGreaterThan(0);
      expect(doc.slice(0, ends[i - 1]) + doc.slice(ends[i - 1], ends[i]! - removed) + doc.slice(ends[i])).toBe(after);
      expect(removed).toBeLessThanOrEqual(ends[i]! - ends[i - 1]!);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(after), `lone surrogate in ${JSON.stringify(after)}`).toBe(false);
    }), fcOpts);
  }, TIMEOUT);

  // Found at PROPS_SEED=20261023: "가" typed as two jamo moves one jamo at a time.
  it("cursorCharRight steps over a decomposed Hangul syllable whole", () => {
    const v = view("가".normalize("NFD"), 0);
    cursorCharRight(v);
    expect(v.state.selection.main.head).toBe(2);
    v.destroy();
  });

  // Found at PROPS_SEED=20261023 with PROPS_RUNS=2000: a ZWJ before an ordinary letter.
  it("Delete before a stray zero-width joiner removes only the joiner, not the letter after it", () => {
    const v = view("\u200da", 0);
    deleteCharForward(v);
    expect(v.state.doc.toString()).toBe("a");
    v.destroy();
  });

  // Backspace after "é" typed as e + U+0301 removes only the accent (as Notepad does; macOS removes the whole letter).
  it("current behaviour: Backspace after a decomposed é removes the accent, not the letter", () => {
    const v = view("e\u0301", 2);
    deleteCharBackward(v);
    expect(v.state.doc.toString()).toBe("e");
    v.destroy();
  });
});

describe("the word count (editor readout)", () => {
  const HAN = fc.constantFrom(..."的一是不了人我在有他", "𠀀", "𠮷", "𡃁", "𪚥", "㐀", "䶵");

  it("counts every Chinese character as one word, rare and extension characters included", () => {
    fc.assert(fc.property(fc.array(HAN, { minLength: 1, maxLength: 30 }), (chars) => {
      expect(countWords(chars.join(""))).toBe(chars.length);
    }), fcOpts);
  });

  it("counts no word in zero-width characters, BOM, NBSP and other blanks", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("​", "‌", "‍", "﻿", "⁠", "­", " ", " ", "\t", "\n", "　"), { minLength: 0, maxLength: 12 }), (blanks) => {
      expect(countWords(blanks.join(""))).toBe(0);
    }), fcOpts);
  });

  it("an invisible character inside or next to a word does not change the count", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("abc", "de", "字數", "測試", "x1"), { minLength: 1, maxLength: 6 }), fc.constantFrom("​", "﻿", "⁠", "­"), (words, invisible) => {
      const text = words.join(" ");
      expect(countWords(text + invisible)).toBe(countWords(text));
      expect(countWords(invisible + text)).toBe(countWords(text));
    }), fcOpts);
  });
});

describe("typing triggers (`[[`, `#`, `/`) with Chinese and Unicode text", () => {
  const prose = unicodeText({ maxLength: 10 }).map((t) => t.replace(/[\s[\]#@/{}`^\n]/g, ""));

  it("`[[` followed by any text without a `]` opens the link menu with that text as the query", () => {
    fc.assert(fc.property(prose, plainWord, (lead, query) => {
      const trigger = detectPopupTrigger(`${lead} [[${query}`);
      expect(trigger, `${lead} [[${query}`).toMatchObject({ type: "wikilink", query });
    }), fcOpts);
  });

  it("`#` + a Chinese word after a blank opens no menu: a body `#` is Markdown", () => {
    fc.assert(fc.property(prose, fc.array(fc.constantFrom(..."標籤筆記的一是不了人abc01_"), { minLength: 1, maxLength: 5 }).map((c) => c.join("")), (lead, name) => {
      expect(detectPopupTrigger(`${lead} #${name}`), `${lead} #${name}`).toBeNull();
    }), fcOpts);
  });

  it("current behaviour: full-width ［［ and ＃ (typed in a full-width IME mode) open no menu", () => {
    expect(detectPopupTrigger("［［筆記")).toBeNull();
    expect(detectPopupTrigger("＃標籤")).toBeNull();
    expect(detectPopupTrigger("／草圖")).toBeNull();
  });
});

describe("regressions", () => {
  it("word count: extension characters and invisible characters (found at PROPS_SEED=20261023)", () => {
    expect(countWords("𠮷𠀀的")).toBe(3);
    expect(countWords("\u200b")).toBe(0);
    expect(countWords("字數\u200b")).toBe(2);
    expect(countWords("コーヒー")).toBe(4);
    expect(countWords("Hello 世界")).toBe(3);
  });
});

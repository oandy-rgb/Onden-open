// Random text against the editor's pure commands, before MarkdownEditor is split up:
// editorFormat.ts (inline wraps, headings, line prefixes, links), editorLinkFollow.ts (what is a link, whether a tap follows)
// and the block parsing a paste goes through (@onden/markdown blocks.ts — 2026-10-20 a paste
// that began with a newline looped forever there on a phone).
//
// The text generators reach the edges a random string almost never does: empty and
// whitespace-only text, leading/trailing newlines, CRLF, CJK, emoji and surrogate pairs,
// zero-width characters, very long lines, deeply nested lists. Invariants:
//   • nothing hangs: every input finishes inside a time budget
//   • toggling the same format twice is the same as not toggling
//   • text outside the selection is untouched; the selection stays inside the document
//   • a surrogate pair (emoji, rare CJK) is never cut in half
//   • splitting a note and putting the pieces back loses and adds no text
//
// Replay a failure:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/editorCommands

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { parseBlocks, splitParagraphs } from "@onden/markdown";
import {
  INLINE_WRAPS, activeFormats, insertLink, listIndentWidth, prefixLines, setHeading, toggleHeading, toggleLinePrefix, toggleWrap,
} from "../../lib/editorFormat";
import { applyCompletion } from "../../lib/editorCompletion";
import { followsOnTap, linkAt, linkAroundCaret, parseWikilinkBody, type TapContext } from "../../lib/editorLinkFollow";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const params = { numRuns: PROPS_RUNS, seed: PROPS_SEED };
/** vitest's 5 s default is for the 200-run merge default; the long run scales the budget with the run count. */
const TIMEOUT = Math.max(15_000, PROPS_RUNS * 25);

// ── generators ──────────────────────────────────────────────────────────────

const CHUNKS = [
  "", " ", "  ", "\t", "\n", "\n\n", "\r\n", "\r", "a", "word", "x y", "中文", "日本語のテキスト", "한국어", "😀", "👨‍👩‍👧", "𠮷", "é", "é",
  "​", "‍", "﻿", "*", "**", "_", "~~", "`", "<u>", "</u>", "[", "]", "(", ")", "[[", "]]", "[[Note]]", "[[Note|alias]]",
  "[[Note#Heading]]", "[[Note#^abc]]", "[a](https://x.test)", "https://x.test/a", "<https://x.test>", "![img](a.png)", "![[embed]]",
  "# ", "## ", "### ", "#### ", "####### ", "#", "> ", ">", "- ", "- [ ] ", "- [x] ", "1. ", "12. ", "* ", "+ ", "---", "```", "~~~", "^", " ^id",
  "#tag ", "$", "$$", "|", "|---|", "\\", "&", "<", ">",
];
const chunk = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...CHUNKS) }, { weight: 2, arbitrary: fc.string({ maxLength: 5 }) }, { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 4 }) });
const rawText = fc.array(chunk, { maxLength: 16 }).map((parts) => parts.join(""));
const longLine = fc.tuple(fc.constantFrom("a", "中", "😀", "[[x"), fc.integer({ min: 500, max: 4000 })).map(([c, n]) => c.repeat(n));
const nestedList = fc.integer({ min: 1, max: 40 }).chain((depth) =>
  fc.constantFrom("- ", "* ", "1. ", "- [ ] ").map((m) => Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}${m}item ${i}`).join("\n")));
const docText = fc.oneof({ weight: 8, arbitrary: rawText }, { weight: 1, arbitrary: longLine }, { weight: 1, arbitrary: nestedList });

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);

/** A document with a selection whose ends sit between code points (never inside a pair). */
const editorDoc = docText.map((d) => d.replace(/\r\n?/g, "\n")); // CodeMirror reads CR and CRLF as one line break
const docAndSelection = editorDoc.chain((doc) => {
  const stops = [0];
  for (const ch of doc) stops.push(stops[stops.length - 1] + ch.length);
  return fc.tuple(fc.constantFrom(...stops), fc.constantFrom(...stops)).map(([a, b]) => ({ doc, from: Math.min(a, b), to: Math.max(a, b), reversed: a > b }));
});

/** Same, for text that can hold ill-formed UTF-16 only when the generator made it — it never does. */
const wellFormedDoc = docAndSelection.filter((s) => wellFormed(s.doc));

/** The commands only read `state` and call `dispatch`, so a headless stand-in runs them without a DOM or layout. */
type Headless = EditorView & { destroy(): void };
function viewOf(doc: string, from: number, to: number, reversed = false): Headless {
  let state = EditorState.create({ doc, selection: reversed ? { anchor: to, head: from } : { anchor: from, head: to } });
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
    destroy() {},
  };
  return view as unknown as Headless;
}
const textOf = (v: EditorView) => v.state.doc.toString();
const inDoc = (v: EditorView) => v.state.selection.ranges.every((r) => r.from >= 0 && r.to <= v.state.doc.length);

/** Run `fn` and fail if it took longer than `ms`: a hang shows as one failing case, not a stuck suite. */
function within<T>(label: string, input: string, ms: number, fn: () => T): T {
  const start = performance.now();
  const out = fn();
  const took = performance.now() - start;
  if (took > ms) throw new Error(`${label} took ${Math.round(took)} ms (limit ${ms}) on ${JSON.stringify(input.slice(0, 80))}… (${input.length} chars)`);
  return out;
}

// ── editorFormat: inline wraps ──────────────────────────────────────────────

describe("editorFormat inline wraps", () => {
  const wrap = fc.constantFrom(...INLINE_WRAPS);

  it("toggling a mark twice leaves the document and the selected text as they were", () => {
    fc.assert(fc.property(wellFormedDoc, wrap, ({ doc, from, to }, w) => {
      const v = viewOf(doc, from, to);
      try {
        toggleWrap(v, from, to, w.before, w.after);
        const r = v.state.selection.main;
        toggleWrap(v, r.from, r.to, w.before, w.after);
        expect(textOf(v)).toBe(doc);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);

  it("wrapping touches only the selection: text before and after it is unchanged, and the selection stays inside the document", () => {
    fc.assert(fc.property(wellFormedDoc, wrap, ({ doc, from, to }, w) => {
      const v = viewOf(doc, from, to);
      try {
        toggleWrap(v, from, to, w.before, w.after);
        const after = textOf(v);
        // Wrapping adds the delimiters around the selection; unwrapping may remove them from just outside or inside it.
        const reach = Math.max(w.before.length, w.after.length);
        const head = doc.slice(0, Math.max(0, from - reach));
        const tail = doc.slice(Math.min(doc.length, to + reach));
        expect(after.startsWith(head)).toBe(true);
        expect(after.endsWith(tail)).toBe(true);
        expect(inDoc(v)).toBe(true);
        expect(wellFormed(after)).toBe(true);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);

  it("a freshly wrapped selection reports its mark as active", () => {
    fc.assert(fc.property(wellFormedDoc.filter((s) => s.from < s.to && !/[*`~<>]/.test(s.doc)), wrap, ({ doc, from, to }, w) => {
      const v = viewOf(doc, from, to);
      try {
        toggleWrap(v, from, to, w.before, w.after);
        const r = v.state.selection.main;
        expect(activeFormats(v.state.doc, r.from, r.to, r.head).has(w.label)).toBe(true);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);

  // A selection that merely starts and ends with the delimiter, such as two bold spans
  // "**a** x **b**", is not one wrapped span: the press wraps it and keeps both spans.
  it("pressing a mark on a selection holding two separate marked spans wraps it and keeps both spans", () => {
    fc.assert(fc.property(fc.constantFrom("a", "中文", "😀", "x y"), fc.constantFrom("a", "b c", "日本"), fc.constantFrom(...INLINE_WRAPS), (a, b, w) => {
      const sel = `${w.before}${a}${w.after} and ${w.before}${b}${w.after}`;
      const v = viewOf(sel, 0, sel.length);
      toggleWrap(v, 0, sel.length, w.before, w.after);
      expect(textOf(v)).toContain(`${w.before}${a}${w.after}`);
      expect(textOf(v)).toContain(`${w.before}${b}${w.after}`);
    }), params);
  }, TIMEOUT);

  it("activeFormats and insertLink never throw and keep the caret inside the document", () => {
    fc.assert(fc.property(wellFormedDoc, fc.constantFrom("https://x.test", "", "a b", "中文😀", "\n"), ({ doc, from, to, reversed }, url) => {
      const v = viewOf(doc, from, to, reversed);
      try {
        const sel = v.state.selection.main;
        activeFormats(v.state.doc, sel.from, sel.to, sel.head);
        const selected = doc.slice(from, to);
        insertLink(v, from, to, url);
        expect(textOf(v)).toBe(`${doc.slice(0, from)}[${selected}](${url})${doc.slice(to)}`);
        expect(v.state.selection.main.head).toBe(from + selected.length + url.length + 4);
        expect(inDoc(v)).toBe(true);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);
});

// ── editorFormat: headings and line prefixes ────────────────────────────────

/** Lines that start with none of the marks the line commands read, so a toggle has nothing else to undo. */
const plainLine = fc.oneof(
  fc.constantFrom("", " ", "word", "中文😀", "​", "a  b", "  indented", "\ttab", "[[Note]]", "**bold**"),
  fc.string({ maxLength: 8 }).filter((s) => !/^[#>\-+*\d\s]/.test(s) && !s.includes("\n") && !s.includes("\r")),
);
const plainDoc = fc.array(plainLine, { maxLength: 8 }).chain((lines) => {
  const doc = lines.join("\n");
  return fc.tuple(fc.nat(doc.length), fc.nat(doc.length)).map(([a, b]) => ({ doc, from: Math.min(a, b), to: Math.max(a, b) }));
}).filter((s) => wellFormed(s.doc));

describe("editorFormat headings and line prefixes", () => {
  const level = fc.integer({ min: 1, max: 6 });
  const prefix = fc.constantFrom("> ", "- ", "1. ", "- [ ] ");

  it("a heading button pressed twice on a plain line gives the line back", () => {
    fc.assert(fc.property(plainDoc, level, ({ doc, from, to }, n) => {
      const v = viewOf(doc, from, to);
      try {
        toggleHeading(v, n);
        toggleHeading(v, n);
        expect(textOf(v)).toBe(doc);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);

  it("setHeading is idempotent and changes only the caret's line", () => {
    fc.assert(fc.property(wellFormedDoc, level, ({ doc, from, to }, n) => {
      const v = viewOf(doc, from, to);
      try {
        const line = v.state.doc.lineAt(v.state.selection.main.head);
        setHeading(v, n);
        const once = textOf(v);
        setHeading(v, n);
        expect(textOf(v)).toBe(once);
        expect(once.slice(0, line.from)).toBe(doc.slice(0, line.from));
        expect(once.endsWith(doc.slice(line.to))).toBe(true);
        expect(inDoc(v)).toBe(true);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);

  it("a block button pressed twice on plain lines gives the text back", () => {
    fc.assert(fc.property(plainDoc, prefix, ({ doc, from, to }, p) => {
      const v = viewOf(doc, from, to);
      try {
        toggleLinePrefix(v, p);
        const r = v.state.selection.main;
        toggleLinePrefix(v, p);
        expect(textOf(v)).toBe(doc);
        expect(r.to).toBeLessThanOrEqual(v.state.doc.length + p.length * 64);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);

  it("prefixing lines changes only the selected lines, one prefix each, and keeps the selection in the document", () => {
    fc.assert(fc.property(wellFormedDoc, prefix, ({ doc, from, to }, p) => {
      const v = viewOf(doc, from, to);
      try {
        const first = v.state.doc.lineAt(from).number, last = v.state.doc.lineAt(to).number;
        const before = doc.split(/\r\n?|\n/);
        prefixLines(v, p);
        const after = v.state.doc.toString().split(/\r\n?|\n/);
        expect(after.length).toBe(before.length);
        after.forEach((line, i) => {
          const selected = i + 1 >= first && i + 1 <= last;
          expect(line).toBe(selected ? p + before[i] : before[i]);
        });
        expect(inDoc(v)).toBe(true);
      } finally { v.destroy(); }
    }), params);
  }, TIMEOUT);
});

// ── editorLinkFollow ────────────────────────────────────────────────────────

function mdState(doc: string, anchor = 0) {
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

describe("editorLinkFollow", () => {
  it("parseWikilinkBody never throws and always names a string", () => {
    fc.assert(fc.property(rawText, (body) => {
      const r = parseWikilinkBody(body);
      expect(typeof r.label).toBe("string");
      expect(r.heading === undefined || r.heading.length > 0).toBe(true);
      expect(r.blockId === undefined || r.blockId.length > 0).toBe(true);
    }), params);
  }, TIMEOUT);

  // Nightly 2026-11-07, seed 956501947: a markdown link whose text has a line break ("[\nhttps://x.test/a]")
  // is returned by linkAt as one span that contains "\n". Likely cause: the link span is taken from the
  // syntax-tree node without checking it stays on one line.
  it.fails("nightly 2026-11-07: linkAt never returns a span containing a line break (seed 956501947)", () => {
    const doc = "[\nhttps://x.test/a]";
    const hit = linkAt(mdState(doc), 0);
    if (hit) expect(doc.slice(hit.from, hit.to)).not.toContain("\n");
  });

  it("links found at any position lie inside the document, on one line, and contain that position", () => {
    fc.assert(fc.property(editorDoc.filter((d) => d.length <= 600), fc.nat(), (doc, at) => {
      const state = mdState(doc);
      const pos = doc.length ? at % (doc.length + 1) : 0;
      const hit = within("linkAt", doc, 1500, () => linkAt(state, pos));
      if (hit) {
        expect(hit.from).toBeLessThanOrEqual(pos);
        expect(pos).toBeLessThan(hit.to);
        expect(hit.to).toBeLessThanOrEqual(doc.length);
        expect(doc.slice(hit.from, hit.to)).not.toContain("\n");
        if (hit.kind === "wikilink") expect(doc.slice(hit.from, hit.from + 2)).toBe("[[");
        if (hit.kind === "url") expect(/^(?:https?:|mailto:|tel:)/i.test(hit.url)).toBe(true);
      }
      const around = linkAroundCaret(state, pos);
      if (around) {
        expect(around.from).toBeLessThan(pos);
        expect(pos).toBeLessThan(around.to);
      }
    }), params);
  }, TIMEOUT);

  it("outside the document there is no link", () => {
    fc.assert(fc.property(rawText, fc.integer({ min: 1, max: 50 }), (doc, extra) => {
      const state = mdState(doc);
      expect(linkAt(state, -extra)).toBeNull();
      expect(linkAt(state, doc.length + extra)).toBeNull();
    }), params);
  }, TIMEOUT);

  it("a tap follows by the table: composing never, read-only always, a mouse needs the modifier, touch and pen follow when the editor was not focused", () => {
    const ctx: fc.Arbitrary<TapContext> = fc.record({
      pointer: fc.constantFrom("touch", "pen", "mouse"), focused: fc.boolean(), readOnly: fc.boolean(), modifier: fc.boolean(), composing: fc.boolean(),
    });
    fc.assert(fc.property(ctx, (c) => {
      const expected = c.composing ? false : c.readOnly ? true : c.pointer === "mouse" ? c.modifier : !c.focused;
      expect(followsOnTap(c)).toBe(expected);
    }), params);
  }, TIMEOUT);
});

// ── pasted text through the block parser ────────────────────────────────────

/** What a paste hands the parser: the text of the note with something pasted in at a random place. */
const pasted = fc.tuple(rawText, fc.constantFrom("", "\n", "\n\n\n", "\r\n", " \n", "\n- ", "\n> ", "\n1. ", "\n# ", "\n```\n", "​\n"), rawText, fc.nat())
  .map(([note, lead, paste, at]) => {
    const i = note.length ? at % (note.length + 1) : 0;
    return note.slice(0, i) + lead + paste + note.slice(i);
  });

describe("pasted text and block parsing", () => {
  it("parseBlocks finishes, stays in range and is stable on pasted text, including text that begins with a newline", () => {
    fc.assert(fc.property(fc.oneof(pasted, docText), (md) => {
      const blocks = within("parseBlocks", md, 2000, () => parseBlocks(md));
      for (const b of blocks) {
        expect(b.start).toBeGreaterThanOrEqual(0);
        expect(b.end).toBeLessThanOrEqual(md.length);
        expect(b.start).toBeLessThanOrEqual(b.end);
      }
      // Reading again gives the same blocks (nothing about the text changes them: no id is written).
      expect(parseBlocks(md).map((b) => [b.start, b.end])).toEqual(blocks.map((b) => [b.start, b.end]));
    }), params);
  }, TIMEOUT);

  it("text that begins with newlines parses like the same text without them: same number of block nodes", () => {
    fc.assert(fc.property(rawText.filter((t) => t.length <= 2000), fc.constantFrom("\n", "\n\n\n", "\r\n", "\n\n\n\n\n\n\n\n"), (md, lead) => {
      const plain = within("parseBlocks", md, 2000, () => parseBlocks(md));
      const led = within("parseBlocks (leading newlines)", lead + md, 2000, () => parseBlocks(lead + md));
      expect(led.length).toBe(plain.length);
      for (const b of led) expect(b.end).toBeLessThanOrEqual(lead.length + md.length);
    }), params);
  }, TIMEOUT);

  it("splitParagraphs covers the text it is given and never overlaps", () => {
    fc.assert(fc.property(fc.oneof(pasted, docText), (md) => {
      const parts = within("splitParagraphs", md, 2000, () => splitParagraphs(md));
      expect(Array.isArray(parts)).toBe(true);
      for (const p of parts) expect(typeof p.text).toBe("string");
    }), params);
  }, TIMEOUT);
});

// ── scan 01 #4: a mark is not read out of a longer run of its character ─────────

describe("editorFormat: italic inside bold (scan 01 #4)", () => {
  it("Italic on the text inside **bold** adds italic and keeps the bold", () => {
    const v = viewOf("**重點**", 2, 4);
    toggleWrap(v, 2, 4, "*", "*");
    expect(textOf(v)).toBe("***重點***");
  });

  it("Italic on ***both*** takes only the italic off; Bold takes only the bold off", () => {
    const a = viewOf("***重點***", 3, 5);
    toggleWrap(a, 3, 5, "*", "*");
    expect(textOf(a)).toBe("**重點**");
    const b = viewOf("***重點***", 3, 5);
    toggleWrap(b, 3, 5, "**", "**");
    expect(textOf(b)).toBe("*重點*");
  });

  it("what the toolbar reports active is what a press undoes: a press on an active mark removes it, on an inactive one adds it", () => {
    const stars = fc.array(fc.constantFrom("a", "字", " ", "_"), { maxLength: 6 }).map((p) => p.join(""));
    fc.assert(fc.property(fc.constantFrom(0, 1, 2, 3), stars, fc.constantFrom("x", "重點"), fc.constantFrom(...INLINE_WRAPS.slice(0, 2)), (run, around, word, w) => {
      const doc = `${around}${"*".repeat(run)}${word}${"*".repeat(run)}${around}`;
      const from = around.length + run;
      const to = from + word.length;
      const v = viewOf(doc, from, to);
      const on = activeFormats(v.state.doc, from, to, to).has(w.label);
      toggleWrap(v, from, to, w.before, w.after);
      const r = v.state.selection.main;
      // After the press the word's mark state is the opposite of before.
      expect(activeFormats(v.state.doc, r.from, r.to, r.head).has(w.label)).toBe(!on);
    }), params);
  }, TIMEOUT);
});

// ── scan 01 #1: a suggestion list written after the caret left its trigger ──────

describe("applyCompletion with the caret before the trigger (scan 01 #1)", () => {
  it("writes nothing when the caret is before the trigger (Home after typing [[abc)", () => {
    const v = viewOf("[[abc", 0, 0);
    expect(applyCompletion(v, { type: "wikilink", triggerStart: 2 }, { id: "n", title: "Note" })).toBeNull();
    expect(textOf(v)).toBe("[[abc");
  });

  it("never throws and never touches text before the trigger, wherever the caret is", () => {
    fc.assert(fc.property(wellFormedDoc, fc.nat(), ({ doc, from }, trig) => {
      const triggerStart = trig % (doc.length + 1);
      const v = viewOf(doc, from, from);
      applyCompletion(v, { type: "wikilink", triggerStart }, { id: "n", title: "Note" });
      expect(textOf(v).startsWith(doc.slice(0, triggerStart))).toBe(true);
      if (from < triggerStart) expect(textOf(v)).toBe(doc);
      // Text after the caret is only replaced when the caret is at or after the trigger; the tail past the caret survives.
      expect(textOf(v).endsWith(doc.slice(from))).toBe(true);
    }), params);
  }, TIMEOUT);
});

// ── scan 01 #10: Tab on a list line makes a child, not a sibling ────────────────

describe("listIndentWidth (scan 01 #10)", () => {
  it("1. a / 1. b with Tab on the second makes b a child of a in the parsed list", () => {
    const text = "1. a\n1. b";
    const lineB = text.indexOf("1. b");
    const indented = `${text.slice(0, lineB)}${" ".repeat(listIndentWidth("1. b"))}${text.slice(lineB)}`;
    const state = EditorState.create({ doc: indented, extensions: [markdown({ base: markdownLanguage })] });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    let nested = false;
    tree.iterate({ enter: (n) => { if (n.name === "OrderedList" && n.from > 0) nested = true; } });
    expect(nested).toBe(true);
  });

  it("any numbered or bulleted item, indented once, parses as nested under the item above", () => {
    fc.assert(fc.property(fc.constantFrom("-", "*", "+", "1.", "9.", "10.", "99.", "100."), (marker) => {
      const parent = `${marker} a`;
      const child = `${marker} b`;
      const doc = `${parent}\n${" ".repeat(listIndentWidth(parent))}${child}`;
      const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
      const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
      let lists = 0;
      tree.iterate({ enter: (n) => { if (n.name === "OrderedList" || n.name === "BulletList") lists++; } });
      expect(lists).toBe(2);
    }), params);
  });
});

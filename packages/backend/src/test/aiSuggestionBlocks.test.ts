import { describe, expect, it } from "vitest";
import { applyItems, decodeUnit, MAX_PARAGRAPHS, proposeItems, SuggestionTooLargeError } from "../services/aiSuggestionBlocks.js";

const doc = (...paragraphs: string[]) => paragraphs.join("\n\n") + "\n";

describe("proposeItems / applyItems", () => {
  const base = doc("# Title", "first", "second", "third");

  it("turns every change into a place and back into the proposal", () => {
    const cases = [
      doc("# Title", "first", "SECOND", "third"),
      doc("# Title", "second", "third"),
      doc("# Title", "first", "second", "NEW", "third"),
      doc("NEW", "# Title", "first", "second", "third"),
      doc("# Title", "first", "second", "third", "NEW LAST"),
      doc("# Title", "first", "two", "extra", "third"),
      doc("# Title", "uno", "third"),
      "\n",
    ];
    for (const proposed of cases) {
      const items = proposeItems(base, proposed);
      expect(applyItems(base, items).markdown, JSON.stringify(proposed)).toBe(proposed);
    }
  });

  it("gives one item per changed paragraph and none for an identical text", () => {
    expect(proposeItems(base, base)).toEqual([]);
    const items = proposeItems(base, doc("# Title", "FIRST", "second", "THIRD"));
    expect(items.map((i) => i.kind)).toEqual(["replace", "replace"]);
  });

  it("applies only the chosen items", () => {
    const items = proposeItems(base, doc("# Title", "FIRST", "second", "THIRD"));
    expect(applyItems(base, [items[1]!]).markdown).toBe(doc("# Title", "first", "second", "THIRD"));
  });

  it("tells the n-th identical paragraph apart", () => {
    const twin = doc("same", "mid", "same");
    const items = proposeItems(twin, doc("same", "mid", "changed"));
    expect(items).toEqual([{ kind: "replace", baseText: "same", baseOccurrence: 1, newText: "changed" }]);
    expect(applyItems(twin, items).markdown).toBe(doc("same", "mid", "changed"));
  });

  it("reports a place that is not in the base instead of guessing", () => {
    const r = applyItems(base, [{ kind: "replace", baseText: "gone", baseOccurrence: 0, newText: "x" }]);
    expect(r.missing).toEqual([0]);
    expect(r.markdown).toBe(base);
  });

  it("keeps a code fence with blank lines in one place and each list item separate", () => {
    const md = "intro\n\n```js\na\n\nb\n```\n\n- one\n- two\n";
    const items = proposeItems(md, md.replace("b\n```", "B\n```").replace("- two", "- TWO"));
    expect(items.map((i) => i.kind)).toEqual(["replace", "replace"]);
    expect(applyItems(md, items).markdown).toBe(md.replace("b\n```", "B\n```").replace("- two", "- TWO"));
    // a new list item joins the list with the list's newline
    const added = proposeItems(md, md + "- three\n");
    expect(applyItems(md, added).markdown).toBe(md + "- three\n");
  });

  it("round-trips untouched text, odd separators included", () => {
    for (const md of ["a\n\nb", "a\n\n\n\nb\n", "", "only\n", "---\ntitle: x\n---\n\nbody\n"]) {
      expect(applyItems(md, []).markdown).toBe(md);
    }
  });

  it("a rewritten paragraph is the AI's text as written: `^id` is plain text now, none is kept or added (the anchor moves with the text)", () => {
    const md = "alpha ^ab12cd\n\nbeta\n";
    expect(applyItems(md, proposeItems(md, "ALPHA\n\nbeta\n")).markdown).toBe("ALPHA\n\nbeta\n");
    expect(applyItems(md, proposeItems(md, "ALPHA ^zz99zz\n\nbeta\n")).markdown).toBe("ALPHA ^zz99zz\n\nbeta\n");
    const quote = "> a\n^q1w2e3\n\nbeta\n";
    expect(applyItems(quote, proposeItems(quote, "> A\n\nbeta\n")).markdown).toBe("> A\n\nbeta\n");
  });

  it("refuses a note too long to cut into places", () => {
    const many = Array.from({ length: MAX_PARAGRAPHS + 1 }, (_, i) => `p${i}`);
    expect(() => proposeItems(doc(...many), doc("x"))).toThrow(SuggestionTooLargeError);
  });
});

describe("what the reader sees decides what is a place", () => {
  const take = (base: string, proposed: string, pick: (i: number) => boolean = () => true) =>
    applyItems(base, proposeItems(base, proposed).filter((_, i) => pick(i))).markdown;

  it("a change of indentation is a place: code, nested lists, hard line breaks, full-width indent", () => {
    for (const [before, after] of [
      ["```py\nif x:\n    y()\n```\n", "```py\nif x:\n  y()\n```\n"],
      ["- a\n  - b\n", "- a\n- b\n"],
      ["line one  \nline two\n", "line one\nline two\n"],
      ["\u3000\u3000indented text\n", "indented text\n"],
    ]) {
      expect(proposeItems(before, after).length, JSON.stringify(after)).toBeGreaterThan(0);
      expect(take(before, after), JSON.stringify(after)).toBe(after);
    }
    // …while a trailing space on a line shows nothing
    expect(proposeItems("a b \n\nc\n", "a b\n\nc\n")).toEqual([]);
  });

  it("a gap that only changes spacing is stored as such, and the text of the place is unchanged", () => {
    const items = proposeItems("- a\n\n- b\n", "- a\n- b\n");
    expect(items).toHaveLength(1);
    expect(decodeUnit(items[0]!.kind === "delete" ? "" : items[0]!.newText).text).toBe(items[0]!.baseText);
  });

  it("adding after the last paragraph is an insert, not a second 'change' of the last paragraph", () => {
    for (const [before, after] of [
      ["- a\n", "- a\n- b\n"], ["- a\n", "- a\n\n- b\n"], ["text\n", "text\n\n- b\n"], ["# h\n", "# h\ntext\n"],
    ]) {
      const items = proposeItems(before, after);
      expect(items.map((i) => i.kind), after).toEqual(["insert"]);
      expect(applyItems(before, items).markdown, after).toBe(after);
    }
  });

  it("a blank line the AI adds or drops after a heading is written, even though it shows nothing; one against two is not", () => {
    // only the blank line differs: still a suggestion, never 'nothing to suggest'
    expect(proposeItems("# H\ntext\n\n- a\n- b\n", "# H\n\ntext\n\n- a\n- b\n")).toHaveLength(1);
    for (const [before, after] of [
      ["# H\ntext\n\n- a\n- b\n", "# H\n\ntext\n\n- a\n- b\n"],
      ["# H\ntext\n\n- a\n- b\n", "# H\n\ntext\n\n- a\n- b\n- c\n"],
      ["# H\n\ntext\n", "# H\ntext\n"],
      ["### 背景\n\n- x\n", "### 背景\n- x\n- y\n"],
    ]) expect(take(before, after), JSON.stringify(after)).toBe(after);
    expect(proposeItems("a\n\nb\n", "a\n\n\n\nb\n")).toEqual([]);
  });

  it("a paragraph with an id moved to the very top: its new place alone never repeats the id", () => {
    const base = "# 標題\n\n結論 ^c1\n";
    const proposed = "結論 ^c1\n\n# 標題\n";
    const items = proposeItems(base, proposed);
    expect(take(base, proposed)).toBe(proposed);
    const insert = items.findIndex((i) => i.kind === "insert");
    expect(take(base, proposed, (i) => i === insert).match(/\^c1/g)).toHaveLength(1);
  });

  it("a moved paragraph with an id: its new place alone never gives two blocks the same id; its old place alone loses it", () => {
    const base = "first ^aa11aa\n\nsecond\n\nthird\n";
    const proposed = "second\n\nthird\n\nfirst ^aa11aa\n";
    const items = proposeItems(base, proposed);
    expect(take(base, proposed)).toBe(proposed);
    const insert = items.findIndex((i) => i.kind === "insert");
    const added = take(base, proposed, (i) => i === insert);
    expect(added.match(/\^aa11aa/g)).toHaveLength(1);
    expect(added).toContain("first ^aa11aa\n\nsecond");
    const removed = take(base, proposed, (i) => items[i]!.kind === "delete");
    expect(removed).not.toContain("first");
  });

  it("a text with its front matter taken out and a paragraph put first: the paragraph lands after the front matter when only it is accepted", () => {
    const base = "---\ntitle: x\n---\n\nbody\n";
    const proposed = "# Intro\n\nbody\n";
    const items = proposeItems(base, proposed);
    expect(items.map((i) => i.kind).sort()).toEqual(["delete", "insert"]);
    expect(take(base, proposed)).toBe(proposed);
    const added = take(base, proposed, (i) => items[i]!.kind === "insert");
    expect(added.startsWith("---\ntitle: x\n---")).toBe(true);
    expect(added).toContain("# Intro");
  });

  it("taking a spacing place and refusing the delete between does not turn the next text into a lazy line of the list item", () => {
    const base = "- a\n\npara\n\n- b\n";
    const proposed = "- a\n- b\n";
    const items = proposeItems(base, proposed);
    const result = take(base, proposed, (i) => items[i]!.kind === "replace");
    expect(result).toBe("- a\n\npara\n\n- b\n"); // a's own spacing is now tight, but a blank line stays before the text
    const noPara = take(base, proposed, (i) => items[i]!.kind === "replace" || items[i]!.kind === "delete");
    expect(noPara).toBe(proposed);
  });

  it("a text line the proposal itself puts right after a list item or quote stays there: the proposal's adjacency is kept", () => {
    for (const [before, after] of [
      ["- a\ncont\n", "- A\ncont\n"],
      ["- a\n  cont\n", "- a\ncont\n"],
      ["> q\nnext\n", "> Q\nnext\n"],
      ["- a\n\ncont\n", "- A\ncont\n"],
    ]) {
      expect(take(before, after), JSON.stringify(after)).toBe(after);
    }
  });

  it("a blank line made to keep blocks apart is written with the note's own line ending", () => {
    const base = "- a\r\n\r\npara\r\n\r\n- b\r\n";
    const items = proposeItems(base, "- a\n- b\n");
    const out = take(base, "- a\n- b\n", (i) => items[i]!.kind === "replace");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("a Windows-line-ending note stays Windows line endings", () => {
    const base = "# T\r\n\r\nalpha\r\n\r\nbeta\r\n";
    const out = take(base, "# T\n\nALPHA\nline two\n\nbeta\n");
    expect(out).toBe("# T\r\n\r\nALPHA\r\nline two\r\n\r\nbeta\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

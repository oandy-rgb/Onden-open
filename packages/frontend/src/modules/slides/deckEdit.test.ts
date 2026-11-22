import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { undoLayouts, carryLayouts, deletePage, duplicatePage, insertPage, movePage, pageIndexAt } from "./deckEdit";
import { pagesOf } from "./pages";
import { parseDeck } from "./slides";

const RULE = "## A\n- a1\n\n---\n\n## B\nbee\n\n---\n\n## C\n- c1";
const HEADS = "Intro\n\n## A\nx\n\n## B\ny\n\n## C\nz";
const texts = (md: string) => parseDeck(md).slides.map((s) => s.markdown);

describe("page ranges", () => {
  it("each page's range is its own text, without the --- line or blank lines", () => {
    const deck = parseDeck(RULE);
    expect(deck.slides.map((s) => RULE.slice(s.from, s.to))).toEqual(["## A\n- a1", "## B\nbee", "## C\n- c1"]);
    expect(deck.split).toBe("rule");
    expect(parseDeck(HEADS).split).toBe("heading");
  });

  it("is counted from the start of the note, frontmatter included; a --- inside a code block is no break", () => {
    const md = "---\ntitle: t\n---\n## A\n```\n---\n```\n\n---\n\n## B";
    const deck = parseDeck(md);
    expect(deck.slides.map((s) => md.slice(s.from, s.to))).toEqual(["## A\n```\n---\n```", "## B"]);
  });

  it("a text with no final newline and with CRLF", () => {
    expect(parseDeck("## A\n\n---\n\n## B").slides[1].to).toBe("## A\n\n---\n\n## B".length);
    const crlf = "## A\r\n\r\n---\r\n\r\n## B";
    const deck = parseDeck(crlf);
    expect(deck.slides.map((s) => crlf.replace(/\r\n/g, "\n").slice(s.from, s.to))).toEqual(["## A", "## B"]);
  });

  it("an offset belongs to the page it is in, or the one before when it is in the separator", () => {
    const pages = pagesOf(RULE);
    expect(pageIndexAt(pages, 0)).toBe(0);
    expect(pageIndexAt(pages, RULE.indexOf("bee"))).toBe(1);
    expect(pageIndexAt(pages, RULE.indexOf("---"))).toBe(0);
    expect(pageIndexAt(pages, RULE.length + 50)).toBe(2);
    expect(pages[1].range?.from).toBe(RULE.indexOf("## B"));
    expect(pages[1].range?.to).toBe(RULE.indexOf("\n\n---", RULE.indexOf("## B")));
  });
});

describe("movePage", () => {
  it("moves a page with its whole text; the separators stay in number", () => {
    const edit = movePage(RULE, 0, 2)!;
    expect(edit.text).toBe("## B\nbee\n\n---\n\n## C\n- c1\n\n---\n\n## A\n- a1");
    expect(edit.order).toEqual([1, 2, 0]);
    expect(edit.select).toBe(2);
  });
  it("last to first, and first to last in a ##-cut note (the intro is a page too)", () => {
    expect(movePage(RULE, 2, 0)!.text).toBe("## C\n- c1\n\n---\n\n## A\n- a1\n\n---\n\n## B\nbee");
    expect(movePage(HEADS, 3, 0)).toBeNull(); // C would join the intro: the intro is no section
    expect(movePage(HEADS, 3, 1)!.text).toBe("Intro\n\n## C\nz\n\n## A\nx\n\n## B\ny");
  });
  it("leaves frontmatter, the end of the text and a source list alone", () => {
    const md = "---\ntitle: t\n---\n## A\n1 [1]\n\n---\n\n## B\n2\n\n---\n\n## Sources\n\n[1] x\n";
    expect(movePage(md, 0, 1)!.text).toBe("---\ntitle: t\n---\n## B\n2\n\n---\n\n## A\n1 [1]\n\n---\n\n## Sources\n\n[1] x\n");
    expect(movePage("## A\n\n---\n\n## B", 0, 1)!.text).toBe("## B\n\n---\n\n## A");
  });
  it("refuses a move that changes nothing or leaves the deck", () => {
    expect(movePage(RULE, 1, 1)).toBeNull();
    expect(movePage(RULE, 0, 3)).toBeNull();
    expect(movePage("", 0, 0)).toBeNull();
  });
  it("keeps the pages apart when a bare --- would have become a heading underline", () => {
    const md = "## A\n- x\n---\n## B\npara";
    const moved = movePage(md, 1, 0)!;
    expect(texts(moved.text)).toEqual(["## B\npara", "## A\n- x"]);
  });
  it("a text offset goes where its text went", () => {
    const edit = movePage(RULE, 0, 2)!;
    const at = RULE.indexOf("bee");
    expect(edit.text.slice(edit.map(at)!, edit.map(at)! + 3)).toBe("bee");
    const a1 = RULE.indexOf("a1");
    expect(edit.text.slice(edit.map(a1)!, edit.map(a1)! + 2)).toBe("a1");
  });
  it("a paragraph's old ^id mark moves with its paragraph", () => {
    const md = "## A\nfirst ^abc123\n\n---\n\n## B\nsecond";
    expect(movePage(md, 0, 1)!.text).toBe("## B\nsecond\n\n---\n\n## A\nfirst ^abc123");
  });
});

describe("an operation that would change what the pages are does nothing", () => {
  it("the first, heading-less page of a ##-cut note can't be moved past a section or copied (it would join it)", () => {
    expect(movePage(HEADS, 0, 1)).toBeNull();
    expect(duplicatePage(HEADS, 0)).toBeNull();
    expect(movePage(HEADS, 1, 2)!.text).toBe("Intro\n\n## B\ny\n\n## A\nx\n\n## C\nz");
  });
  it("a page with a code fence that is never closed can't be moved up over the pages after it", () => {
    const md = "## A\nx\n\n---\n\n## B\ny\n\n---\n\n## C\n```\ncode";
    expect(texts(md)).toHaveLength(3);
    expect(movePage(md, 2, 0)).toBeNull();
  });
  it("a deck with the same pages cut a different way is not sent: every result reads back as the pages shown", () => {
    for (const md of [RULE, HEADS, "A para\n---\n## B"]) {
      const n = parseDeck(md).slides.length;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const edit = movePage(md, i, j);
        if (edit) expect(texts(edit.text)).toEqual(edit.order.map((old) => texts(md)[old]));
      }
    }
  });
});

describe("math and line ends", () => {
  it("a copy keeps the words inside $$ (a ^2 there is the formula's, not a paragraph id)", () => {
    const md = "## A\n$$\nE = mc ^2\n$$\n\n---\n\n## B";
    expect(duplicatePage(md, 0)!.text).toContain("## A\n$$\nE = mc ^2\n$$\n\n---\n\n## B");
    expect(duplicatePage(md, 0)!.text.match(/E = mc \^2/g)).toHaveLength(2);
  });
  it("a note written with \\r\\n stays so", () => {
    const md = "## A\r\n- a\r\n\r\n---\r\n\r\n## B\r\n- b";
    expect(movePage(md, 0, 1)!.text).toBe("## B\r\n- b\r\n\r\n---\r\n\r\n## A\r\n- a");
    expect(deletePage(md, 1)!.text).toBe("## A\r\n- a");
  });
  it("settings frontmatter is skipped the way the cut skips it", () => {
    const md = "---\ntitle: t\nagenda: x\n---\n## A\n\n---\n\n## B";
    expect(movePage(md, 0, 1)!.text).toBe("---\ntitle: t\nagenda: x\n---\n## B\n\n---\n\n## A");
  });
});

describe("duplicatePage", () => {
  it("puts a copy right below, cut the way the note is cut", () => {
    expect(duplicatePage(RULE, 1)!.text).toBe("## A\n- a1\n\n---\n\n## B\nbee\n\n---\n\n## B\nbee\n\n---\n\n## C\n- c1");
    expect(duplicatePage(HEADS, 1)!.text).toBe("Intro\n\n## A\nx\n\n## A\nx\n\n## B\ny\n\n## C\nz");
    expect(duplicatePage(RULE, 1)!.order).toEqual([0, 1, 1, 2]);
  });
  it("the copy carries no ^id mark (not in a code block's text either way)", () => {
    const md = "## A\nfirst ^abc123\n- item ^def456\n```\ncode ^keep\n```";
    expect(duplicatePage(md, 0)!.text).toBe(`${md}\n\n## A\nfirst\n- item\n\`\`\`\ncode ^keep\n\`\`\``);
  });
  it("a single page without any separator is cut with ---", () => {
    expect(duplicatePage("Just text", 0)!.text).toBe("Just text\n\n---\n\nJust text");
  });
});

describe("deletePage", () => {
  it("removes the page and one separator: first, middle, last", () => {
    expect(deletePage(RULE, 0)!.text).toBe("## B\nbee\n\n---\n\n## C\n- c1");
    expect(deletePage(RULE, 1)!.text).toBe("## A\n- a1\n\n---\n\n## C\n- c1");
    expect(deletePage(RULE, 2)!.text).toBe("## A\n- a1\n\n---\n\n## B\nbee");
    expect(deletePage(RULE, 2)!.select).toBe(1);
  });
  it("never removes the only page", () => {
    expect(deletePage("## A\nx", 0)).toBeNull();
    expect(deletePage("", 0)).toBeNull();
  });
  it("a note without a final newline stays so", () => {
    expect(deletePage("## A\n\n---\n\n## B\n", 0)!.text).toBe("## B\n");
  });
});

describe("insertPage", () => {
  it("adds a page in the middle, at the end and at the start, with the note's own cut", () => {
    expect(insertPage(RULE, 1, "新")!.text).toBe("## A\n- a1\n\n---\n\n## 新\n\n---\n\n## B\nbee\n\n---\n\n## C\n- c1");
    expect(insertPage(RULE, 3, "新")!.text).toBe(`${RULE}\n\n---\n\n## 新`);
    expect(insertPage(HEADS, 0, "新")).toBeNull(); // before the intro it would take the intro in
    expect(insertPage(HEADS, 1, "新")!.text).toBe("Intro\n\n## 新\n\n## A\nx\n\n## B\ny\n\n## C\nz");
    expect(insertPage(HEADS, 4, "新")!.text).toBe(`${HEADS}\n\n## 新`);
  });
  it("puts the caret at the end of the new title and selects the page", () => {
    const edit = insertPage(RULE, 1, "新")!;
    expect(edit.text.slice(0, edit.caret)).toBe("## A\n- a1\n\n---\n\n## 新");
    expect(edit.select).toBe(1);
    expect(edit.order).toEqual([0, -1, 1, 2]);
    const last = insertPage(RULE, 3, "新")!;
    expect(last.text.slice(0, last.caret)).toBe(`${RULE}\n\n---\n\n## 新`);
    expect(last.order).toEqual([0, 1, 2, -1]);
  });
  it("an empty note gets one page", () => {
    expect(insertPage("", 0, "新")!.text).toBe("## 新");
    expect(insertPage("---\ntitle: t\n---\n", 0, "新")!.text).toBe("---\ntitle: t\n---\n## 新");
  });
  it("refuses a place outside the deck", () => { expect(insertPage(RULE, 4, "新")).toBeNull(); });
});

describe("carryLayouts", () => {
  it("moves choices with their pages, copies them to a copy and drops those of deleted pages", () => {
    const layouts = { "h:a": "quote", "h:b": "stat", "gone": "text" };
    expect(carryLayouts(layouts, ["h:a", "h:b"], ["h:b", "h:a"], [1, 0])).toEqual({ "h:b": "stat", "h:a": "quote", gone: "text" });
    expect(carryLayouts(layouts, ["h:a", "h:b"], ["h:a", "h:a~2", "h:b"], [0, 0, 1])).toEqual({ "h:a": "quote", "h:a~2": "quote", "h:b": "stat", gone: "text" });
    expect(carryLayouts(layouts, ["h:a", "h:b"], ["h:b"], [1])).toEqual({ "h:b": "stat", gone: "text" });
  });
  it("a layout follows its page through a real move, keys read again from the new text", () => {
    const before = pagesOf(RULE);
    const edit = movePage(RULE, 0, 2)!;
    const after = pagesOf(edit.text);
    const next = carryLayouts({ [before[0].key]: "quote" }, before.map((p) => p.key), after.map((p) => p.key), edit.order);
    expect(next).toEqual({ [after[2].key]: "quote" });
  });
});

describe("undoLayouts", () => {
  it("takes back this operation's choices and keeps those made since", () => {
    const before = { "h:a": "quote" }; const after = { "h:a": "quote", "h:a~2": "quote" };
    expect(undoLayouts({ ...after, "h:c": "text" }, before, after)).toEqual({ "h:a": "quote", "h:c": "text" });
    expect(undoLayouts({ "h:a": "stat", "h:a~2": "quote" }, before, after)).toEqual({ "h:a": "stat" }); // a choice made since stays
  });
});

describe("properties", () => {
  const page = fc.tuple(fc.constantFrom("A", "B", "C", "D", "E"), fc.constantFrom("", "- x", "para", "```\n---\n```", "> q", "$$\nx ^2\n$$"))
    .map(([h, body]) => `## ${h}${body ? `\n${body}` : ""}`);
  // `intro`: a first page with no heading (it is a page only in a note cut at `##`, or one cut by `---`).
  const note = fc.tuple(fc.array(page, { minLength: 1, maxLength: 6 }), fc.constantFrom("rule", "heading"), fc.constantFrom("", "\n"), fc.boolean(), fc.boolean())
    .map(([pagesText, mode, tail, front, intro]) => {
      const sep = mode === "rule" ? "\n\n---\n\n" : "\n\n";
      const all = [...(intro ? ["Intro words"] : []), ...pagesText.map((text, i) => text.replace(/^## (\w)/, `## $1${i}`))];
      return { md: `${front ? "---\ntitle: t\n---\n" : ""}${all.join(sep)}${tail}`, intro };
    });

  it("any move keeps the set of pages and the cut, or is refused; moving back restores the text", () => {
    fc.assert(fc.property(note, fc.nat(6), fc.nat(6), ({ md, intro }, a, b) => {
      const n = parseDeck(md).slides.length;
      const from = a % n, to = b % n;
      const edit = movePage(md, from, to);
      if (!edit) return from === to || intro; // only a heading-less first page can make a move impossible
      expect(texts(edit.text)).toEqual(edit.order.map((old) => texts(md)[old]));
      expect(movePage(edit.text, to, from)!.text).toBe(md);
    }));
  });
  it("whatever is done reads back as the pages it says; copy then delete the copy restores the text", () => {
    fc.assert(fc.property(note, fc.nat(6), ({ md }, a) => {
      const n = parseDeck(md).slides.length;
      const i = a % n;
      const dup = duplicatePage(md, i);
      if (dup) {
        expect(texts(dup.text)).toHaveLength(n + 1);
        expect(deletePage(dup.text, i + 1)!.text).toBe(md);
      }
      const ins = insertPage(md, i, "N");
      if (ins) {
        expect(texts(ins.text)[ins.select]).toBe("## N");
        expect(deletePage(ins.text, ins.select)!.text).toBe(md);
      }
      const del = deletePage(md, i);
      if (del) expect(texts(del.text)).toEqual(del.order.map((old) => texts(md)[old]));
    }));
  });
});

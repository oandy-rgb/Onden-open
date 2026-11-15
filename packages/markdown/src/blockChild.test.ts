import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  extractBlock, noteNamer, planBlockExpand, planBlockMove, planSelectionMove, qualifyLocalLinks, retargetToChild, retargetToParent,
  rewriteLinks, wholeNoteEmbedLines,
} from "./index";
import { anchored, type TestAnchor } from "./test/helpers/anchored.js";

const SOURCE = { id: "11111111-1111-4111-8111-111111111111", title: "Algorithms", slug: "algorithms" };
const isSource = noteNamer({ ...SOURCE, aliases: ["Algo"] });

// A block's id is an anchor row, not text: notes below are written with `^id` marks and turned into text + anchors first.
function move(legacy: string, ref: string) {
  const { markdown, anchors } = anchored(legacy);
  const plan = planBlockMove(markdown, ref, anchors);
  if ("refused" in plan) throw new Error(plan.refused);
  return plan;
}

describe("planBlockMove", () => {
  it("takes a paragraph without its {tags}, and leaves an embed", () => {
    const md = "Intro\n\nBinary search halves the range. {key, exam} ^b1\n\nOutro\n";
    const plan = move(md, "b1");
    expect(plan.body).toBe("Binary search halves the range.");
    expect(plan.tags).toEqual(["key", "exam"]);
    expect(plan.title).toBe("Binary search halves the range.");
    expect(plan.without("Binary search")).toBe("Intro\n\n![[Binary search]]\n\nOutro\n");
  });

  it("takes a list item with its nested items, and keeps the list readable", () => {
    const md = "- one\n- two ^b1\n  - child a\n  - child b\n- three\n";
    const plan = move(md, "b1");
    expect(plan.body).toBe("- two\n  - child a\n  - child b");
    expect(plan.kind).toBe("listItem");
    // The embed is its own paragraph: blank lines keep it out of the items around.
    expect(plan.without("two")).toBe("- one\n\n![[two]]\n\n- three\n");
  });

  it("takes a heading with its whole section, anchors inside travel with it", () => {
    const md = "# Top\n\n## Search {exam} ^s1\n\nIntro text.\n\n- binary ^a1\n- more\n\n### Detail\n\nmore\n\n## Sort\n\nno\n";
    const plan = move(md, "s1");
    expect(plan.body).toBe("## Search\n\nIntro text.\n\n- binary\n- more\n\n### Detail\n\nmore");
    expect(plan.innerRefs).toEqual(["a1"]);
    expect(plan.title).toBe("Search");
    expect(plan.headingNames).toContain("search");
    expect(plan.without("Search")).toBe("# Top\n\n![[Search]]\n\n## Sort\n\nno\n");
  });

  it("keeps a paragraph's inline #tag as written", () => {
    const md = "Text #idea more\n";
    const plan = planBlockMove(md, "o1", [{ id: "o1", from: 0, to: md.trimEnd().length }]);
    if ("refused" in plan) throw new Error(plan.refused);
    expect(plan.tags).toEqual([]);
    expect(plan.body).toBe("Text #idea more");
  });

  it("dedents a nested item", () => {
    const plan = move("- top\n  - inner ^in\n    - leaf\n  - sibling\n- next\n", "in");
    expect(plan.body).toBe("- inner\n  - leaf");
  });

  it("a `^id` typed into the text is text: it is not an anchor and travels as words", () => {
    const md = "Intro\n\nsee ^b1 here\n";
    expect(planBlockMove(md, "b1", [])).toEqual({ refused: "block_not_found" });
    const plan = move("see ^b1 here {t} ^real\n", "real");
    expect(plan.body).toBe("see ^b1 here");
  });

  it("refuses a block it cannot carry out as text", () => {
    const quote = anchored("> quoted line\n\n^q\n");
    expect(planBlockMove(quote.markdown, "q", quote.anchors)).toEqual({ refused: "block_unsupported" });
    const inQuote = anchored("> - item ^q\n> - other\n");
    expect(planBlockMove(inQuote.markdown, "q", inQuote.anchors)).toEqual({ refused: "block_unsupported" });
    expect(planBlockMove("text\n", "zz", [])).toEqual({ refused: "block_not_found" });
    expect(planBlockMove(`${"x ".repeat(20_000)}\n`, "a", [{ id: "a", from: 0, to: 5 }])).toEqual({ refused: "note_too_long" });
  });

  it("the only item of a list can be moved (a tie is the item, not the list)", () => {
    const md = "- only {t}\n";
    const plan = planBlockMove(md, "o", [{ id: "o", from: 0, to: md.trimEnd().length }]);
    expect("refused" in plan ? plan.refused : plan.kind).toBe("listItem");
  });

  it("an anchor whose text moved (it no longer starts a block) is not found", () => {
    const md = "new line\n\nsecond\n";
    expect(planBlockMove(md, "a", [{ id: "a", from: 3, to: 8 }])).toEqual({ refused: "block_not_found" });
    expect("refused" in planBlockMove(md, "a", [{ id: "a", from: 10, to: 16 }])).toBe(false);
  });

  it("makes a title that fits inside [[ ]]", () => {
    const md = "**Bold** [site](http://x.y) a|b #c [[Other|alias]]\n";
    const plan = planBlockMove(md, "t", [{ id: "t", from: 0, to: md.trimEnd().length }]);
    expect("refused" in plan ? plan : plan.title).toBe("Bold site a b c alias");
    expect(move("- [ ] 寫 ^t\n- x\n", "t").title).toBe("寫");
    expect(move(`${"字".repeat(80)} ^t\n`, "t").title).toBe(`${"字".repeat(50)}…`);
    expect(move("![](x.png) ^t\n", "t").title).toBe("");
  });
});

describe("rewriteLinks", () => {
  it("keeps the alias and leaves code, math and other notes alone", () => {
    const md = [
      "[[Algorithms#^b1|the proof]] and ![[Algorithms#^b1|label]]",
      "`[[Algorithms#^b1]]` and `![[Algorithms#^b1]]`",
      "```\n[[Algorithms#^b1]]\n![[Algorithms#^b1]]\n```",
      "[[Other#^b1]] [[Algorithms#^b2]]",
    ].join("\n\n");
    const plan = { ref: "b1", innerRefs: [], headingNames: [] };
    const out = retargetToChild(md, { move: plan, childTarget: "Proof", isSource, sourceIsHere: false });
    expect(out.count).toBe(2);
    expect(out.markdown).toBe(md.replace("[[Algorithms#^b1|the proof]]", "[[Proof|the proof]]").replace("![[Algorithms#^b1|label]]", "![[Proof|label]]"));
  });

  it("reads a link by slug, alias or id as the source note", () => {
    const md = "[[algorithms#^b1]] [[Algo#^b1]] [[onden://node/11111111-1111-4111-8111-111111111111#^b1]]";
    const out = retargetToChild(md, { move: { ref: "b1", innerRefs: [], headingNames: [] }, childTarget: "P", isSource, sourceIsHere: false });
    expect(out.markdown).toBe("[[P]] [[P]] [[P]]");
  });

  it("follows same-note links inside the source note only", () => {
    const move = { ref: "b1", innerRefs: ["a1"], headingNames: ["search", "search-1"] };
    const md = "[[#^b1]] [[#^a1]] [[#Search]] [[#Other]]";
    expect(retargetToChild(md, { move, childTarget: "S", isSource, sourceIsHere: true }).markdown).toBe("[[S]] [[S#^a1]] [[S]] [[#Other]]");
    expect(retargetToChild(md, { move, childTarget: "S", isSource, sourceIsHere: false }).markdown).toBe(md);
  });

  it("names the source in links the moved text had to it by position", () => {
    const body = "see [[#^other]] and [[#^a1]] and [[#Inside]]\n\n### Inside\n";
    const out = qualifyLocalLinks(body, { sourceTarget: "Algorithms", local: { ref: "b1", innerRefs: ["a1"] } });
    expect(out.markdown).toBe("see [[Algorithms#^other]] and [[#^a1]] and [[#Inside]]\n\n### Inside\n");
  });
});

describe("planBlockExpand", () => {
  const isChild = noteNamer({ id: "22222222-2222-4222-8222-222222222222", title: "Proof", slug: "proof" });
  const expand = (md: string, child: string, tags: string[] = []) => {
    const [embed] = wholeNoteEmbedLines(md, isChild);
    if (!embed) throw new Error("no embed");
    return planBlockExpand(md, embed, child, { tags });
  };

  it("puts the one block back with its tags, and says where it is (the caller moves the anchor there)", () => {
    const out = expand("a\n\n![[Proof]]\n\nb\n", "It halves.\n", ["key"]);
    expect(out).toEqual({ markdown: "a\n\nIt halves. {key}\n\nb\n", blockStart: 3, blockEnd: 3 + "It halves. {key}".length });
  });

  it("puts a heading and its section back; the block runs to the end of the section", () => {
    const child = "## Proof\n\ntext\n\n### Deeper\n\nmore\n";
    const out = expand("![[Proof]]\n", child);
    expect(out).toEqual({ markdown: child, blockStart: 0, blockEnd: child.trimEnd().length });
  });

  it("a `^id` in the child's text is plain text and stays as written", () => {
    expect(expand("![[Proof]]\n\nother\n", "text ^mine\n")).toEqual({ markdown: "text ^mine\n\nother\n", blockStart: 0, blockEnd: "text ^mine".length });
  });

  it("indents the lines of a nested embed", () => {
    const md = "- a\n  ![[Proof]]\n";
    const out = expand(md, "- x\n  - y\n");
    expect(out).toEqual({ markdown: "- a\n  - x\n    - y\n", blockStart: md.indexOf("!["), blockEnd: md.indexOf("![") + "- x\n    - y".length });
  });

  it("refuses what would not turn back into one block", () => {
    expect(expand("![[Proof]]\n", "one\n\ntwo\n")).toEqual({ refused: "child_not_one_block" });
    expect(expand("![[Proof]]\n", "- a\n- b\n")).toEqual({ refused: "child_not_one_block" });
    expect(expand("![[Proof]]\n", "# A\n\n# B\n")).toEqual({ refused: "child_not_one_block" });
    expect(expand("![[Proof]]\n", "```\ncode\n```\n")).toEqual({ refused: "child_not_one_block" });
    expect(expand("![[Proof]]\n", "> quote\n")).toEqual({ refused: "child_not_one_block" });
    expect(expand("![[Proof]]\n", "---\ntitle: x\n---\n\ntext\n")).toEqual({ refused: "child_has_frontmatter" });
    expect(expand("![[Proof]]\n", "  \n")).toEqual({ refused: "child_empty" });
  });

  it("finds only whole-line embeds of the whole note, outside code", () => {
    const md = "![[Proof]]\n\ntext ![[Proof]]\n\n![[Proof#Part]]\n\n`![[Proof]]`\n\n```\n![[Proof]]\n```\n\n  ![[proof|x]]  \n";
    expect(wholeNoteEmbedLines(md, isChild).map((l) => md.slice(l.start, l.end))).toEqual(["![[Proof]]", "![[proof|x]]"]);
  });

  it("turns links to the child back into links to the block", () => {
    const out = retargetToParent("[[Proof]] ![[proof|x]] [[Proof#^in]] [[Other]]", { ref: "n1", sourceTarget: "Algorithms", isChild });
    expect(out.markdown).toBe("[[Algorithms#^n1]] ![[Algorithms#^n1|x]] [[Algorithms#^in]] [[Other]]");
  });
});

// ── Properties ──────────────────────────────────────────────────────────────

const word = fc.stringMatching(/^[a-z]{2,8}$/);
const phrase = fc.array(word, { minLength: 1, maxLength: 5 }).map((w) => w.join(" "));
const tagList = fc.uniqueArray(word, { maxLength: 3 });

/** A note of blank-line separated blocks; each has a unique id `k<n>`, written as an old `^k<n>` mark and turned into an
 *  anchor by `anchored`. (No list items: an anchor on the only item of a list reads as the list's, see blockAnchors.test.) */
const note = fc.array(
  fc.record({
    kind: fc.constantFrom("paragraph", "heading"),
    text: phrase,
    tags: tagList,
    more: fc.array(phrase, { maxLength: 2 }),
  }),
  { minLength: 1, maxLength: 6 },
).map((blocks) => {
  const refs: string[] = [];
  const tagged: string[][] = [];
  const text = blocks.map((b, i) => {
    const ref = `k${i}`;
    refs.push(ref); tagged.push(b.tags);
    const tags = b.tags.length ? ` {${b.tags.join(", ")}}` : "";
    if (b.kind === "heading") return `## ${b.text}${tags} ^${ref}\n\n${b.more.join("\n\n")}`.trimEnd();
    return `${b.text}${tags} ^${ref}`;
  }).join("\n\n") + "\n";
  const { markdown, anchors } = anchored(text);
  return { text: markdown, anchors, refs, tagged };
});

describe("properties", () => {
  it("moving a block out and expanding it back restores the note", () => {
    fc.assert(fc.property(note, fc.nat(), ({ text, anchors, refs, tagged }, pick) => {
      const i = pick % refs.length;
      const ref = refs[i]!;
      const plan = planBlockMove(text, ref, anchors);
      if ("refused" in plan) throw new Error(plan.refused);
      const away = plan.without("Child");
      const isChild = noteNamer({ id: "c", title: "Child", slug: "child" });
      const [embed] = wholeNoteEmbedLines(away, isChild);
      expect(embed).toBeDefined();
      const back = planBlockExpand(away, embed!, plan.body, { tags: plan.tags });
      expect(back).toMatchObject({ markdown: text, blockStart: anchors.find((a) => a.id === ref)!.from });
      expect(plan.tags).toEqual(tagged[i]);
    }), { numRuns: 200 });
  });

  it("the child's body is what a block embed shows (minus {tags})", () => {
    fc.assert(fc.property(note, fc.nat(), ({ text, anchors, refs }, pick) => {
      const ref = refs[pick % refs.length]!;
      const plan = planBlockMove(text, ref, anchors);
      if ("refused" in plan) throw new Error(plan.refused);
      const shown = extractBlock(text, ref, anchors)!;
      const [first = "", ...rest] = shown.split("\n");
      expect([first.replace(/ \{[^{}]*\}$/, ""), ...rest].join("\n")).toBe(plan.body);
    }), { numRuns: 200 });
  });

  it("no link to the moved block survives retargeting; other links are unchanged", () => {
    const link = fc.record({
      embed: fc.boolean(), note: fc.constantFrom("Algorithms", "algorithms", "Algo", "Other"),
      id: fc.constantFrom("k0", "k1", "zz"), alias: fc.option(word),
    });
    fc.assert(fc.property(fc.array(link, { maxLength: 8 }), (links) => {
      const text = (l: (typeof links)[number]) => `${l.embed ? "!" : ""}[[${l.note}#^${l.id}${l.alias ? `|${l.alias}` : ""}]]`;
      const md = links.map(text).join("\n\n");
      const out = retargetToChild(md, { move: { ref: "k0", innerRefs: [], headingNames: [] }, childTarget: "Child", isSource, sourceIsHere: false });
      const expected = links.map((l) => (l.id === "k0" && l.note !== "Other"
        ? `${l.embed ? "!" : ""}[[Child${l.alias ? `|${l.alias}` : ""}]]` : text(l))).join("\n\n");
      expect(out.markdown).toBe(expected);
      expect(out.count).toBe(links.filter((l) => l.id === "k0" && l.note !== "Other").length);
      // Rewriting twice changes nothing more.
      expect(retargetToChild(out.markdown, { move: { ref: "k0", innerRefs: [], headingNames: [] }, childTarget: "Child", isSource, sourceIsHere: false }).count).toBe(0);
    }), { numRuns: 200 });
  });
});

describe("planSelectionMove", () => {
  const sel = (md: string, from: string, to = from, anchors: TestAnchor[] = []) => {
    const a = md.indexOf(from), b = md.indexOf(to) + to.length;
    return planSelectionMove(md, a, b, anchors);
  };
  const ok = (r: ReturnType<typeof planSelectionMove>) => {
    if ("refused" in r) throw new Error(r.refused);
    return r;
  };

  it("takes several paragraphs whole, title from the first line", () => {
    const md = "Intro\n\nFirst idea here.\n\nSecond idea.\n\nOutro\n";
    const plan = ok(sel(md, "First idea", "Second idea."));
    expect(plan.body).toBe("First idea here.\n\nSecond idea.");
    expect(plan.title).toBe("First idea here.");
    expect(plan.ref).toBeNull();
    expect(plan.without("First idea here.")).toBe("Intro\n\n![[First idea here.]]\n\nOutro\n");
  });

  it("splits a paragraph cut in the middle: the words around stay as paragraphs", () => {
    const md = "Intro\n\nbefore MIDDLE after\n\nOutro\n";
    const plan = ok(sel(md, "MIDDLE"));
    expect(plan.body).toBe("MIDDLE");
    expect(plan.without("MIDDLE")).toBe("Intro\n\nbefore\n\n![[MIDDLE]]\n\nafter\n\nOutro\n");
  });

  it("a cut that begins or ends at the paragraph's edge leaves only one side", () => {
    const md = "start of it then the rest\n";
    expect(ok(sel(md, "start of it")).without("x")).toBe("![[x]]\n\nthen the rest\n");
    expect(ok(sel(md, "the rest")).without("x")).toBe("start of it then\n\n![[x]]\n");
  });

  it("starts in one paragraph and ends in another: the cut ends of both are split", () => {
    const md = "alpha beta\n\ngamma delta\n";
    const plan = ok(sel(md, "beta", "gamma"));
    expect(plan.body).toBe("beta\n\ngamma");
    expect(plan.without("t")).toBe("alpha\n\n![[t]]\n\ndelta\n");
  });

  it("a tail of only the paragraph's {tags} goes along", () => {
    const md = "head TEXT {x} \n\nnext\n";
    const plan = ok(sel(md, "TEXT"));
    expect(plan.body).toBe("TEXT {x}");
    expect(plan.innerRefs).toEqual([]);
    expect(plan.without("t")).toBe("head\n\n![[t]]\n\nnext\n");
  });

  it("every anchor that starts inside the selection travels with it as an inner ref; ones outside stay", () => {
    const a = anchored("Intro ^i0\n\nFirst idea here. ^i1\n\nSecond idea. ^i2\n\nOutro ^i3\n");
    const plan = ok(sel(a.markdown, "First idea", "Second idea.", a.anchors));
    expect(plan.innerRefs).toEqual(["i1", "i2"]);
    expect(plan.body).toBe("First idea here.\n\nSecond idea.");
  });

  it("takes a list item whole when the selection is inside its text", () => {
    const a = anchored("- one\n- two words ^b1\n  - child\n- three\n");
    const plan = ok(sel(a.markdown, "words", "words", a.anchors));
    expect(plan.body).toBe("- two words\n  - child");
    expect(plan.innerRefs).toEqual(["b1"]);
    expect(plan.without("two")).toBe("- one\n\n![[two]]\n\n- three\n");
  });

  it("a heading moves as its line only, not its section", () => {
    const md = "## Search\n\nbody\n\n## Sort\n";
    const plan = ok(sel(md, "Search"));
    expect(plan.body).toBe("## Search");
    expect(plan.title).toBe("Search");
    expect(plan.headingNames).toContain("search");
    expect(plan.without("Search")).toBe("![[Search]]\n\nbody\n\n## Sort\n");
  });

  it("cuts a long first line with an ellipsis, never through a character", () => {
    const md = `${"字".repeat(80)}\n`;
    const plan = ok(planSelectionMove(md, 0, md.length));
    expect(plan.title).toBe(`${"字".repeat(50)}…`);
    const emoji = `${"👨‍👩‍👧".repeat(60)}\n`;
    expect(ok(planSelectionMove(emoji, 0, emoji.length)).title).toBe(`${"👨‍👩‍👧".repeat(50)}…`);
  });

  it("leaves the cut-along {tags} out of the title", () => {
    const md = "Binary search halves the range. {key}\n";
    const plan = ok(planSelectionMove(md, 0, md.length));
    expect(plan.title).toBe("Binary search halves the range.");
    expect(plan.body).toBe(md.trimEnd());
  });

  it("refuses an empty selection and one in front matter", () => {
    expect(planSelectionMove("a b\n", 1, 2)).toEqual({ refused: "selection_empty" });
    expect(planSelectionMove("---\ntitle: x\n---\n\nbody\n", 4, 12)).toEqual({ refused: "block_not_found" });
  });

  it("links to a block inside the selection follow it into the child", () => {
    const a = anchored("x\n\nsee this ^k1\n\ny\n");
    const plan = ok(sel(a.markdown, "see this", "see this", a.anchors));
    expect(plan.innerRefs).toEqual(["k1"]);
    const links = retargetToChild("go [[Algorithms#^k1]]", { move: plan, childTarget: "see this", isSource, sourceIsHere: false });
    expect(links.markdown).toBe("go [[see this#^k1]]");
  });
});

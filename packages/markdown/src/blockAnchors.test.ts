// Which block a paragraph anchor starts (blocks.ts anchoredBlocks) and how the renderer shows it (remarkBlockId),
// on every block kind (audit D59). The shared fixture is written in the OLD format (`^id` marks): it is the migration's
// input, and `anchored()` (stripLegacyIds) turns it into what a note is now: text without ids plus anchor rows. The
// frontend MarkdownRenderer / extractBlock and the backend md2html load the same fixture.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { legacyBlockAnchors, anchoredBlocks, parseBlocks, parseLegacyBlocks, ondenMarkdownCore, trailingBlockId, BLOCK_ID, stripLegacyIds, type MarkdownProfile } from "./index.js";
import { anchored, type TestAnchor } from "./test/helpers/anchored.js";
import { ondenMarkdown } from "./full.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/blockAnchors.json", import.meta.url), "utf8")) as {
  markdown: string; anchors: Array<{ id: string; kind: string; element: string; text: string }>; blockNodes: string[]; inCode: string[];
};
const note = readFileSync(new URL(`./fixtures/${fixture.markdown}`, import.meta.url), "utf8");

// The fixture's `#topic ^hb` line is Obsidian's hashtag block, which stripLegacyIds refuses (see the report: the old
// reading makes it a block node, the new one does not), so the converted copy drops the hashtag and keeps the anchor.
// Two more ids are left out and tested apart as known gaps: `- nested ^li2` (the ONLY item of a list: item and list start and end
// at the same place, so a tie goes to the list and the anchor tags the `<ul>`, not the `<li>`) and `> quoted ^qp` (a quote's first paragraph is read with the quote).
const GAPS = ["li2", "qp"];
const legacy = anchored(note.replace("Hashtag line #topic ^hb", "Hashtag line ^hb").replace(" ^li2", "").replace(" ^qp", ""));
const expectedAnchors = fixture.anchors.filter((a) => !GAPS.includes(a.id));

// The full pipeline (server exports, the static site); the core one (the
// app, before or without its lazy enhancers) is checked against it below.
// Anchors are offsets into the text as written; the pipeline reads the body (`prepare` drops the frontmatter), so they shift with it.
function html(markdown: string, profile: MarkdownProfile = "published", pipeline: (o: { profile: MarkdownProfile; blockAnchors?: TestAnchor[] }) => ReturnType<typeof ondenMarkdown> = ondenMarkdown, anchors: TestAnchor[] = []): string {
  const prepared = ondenMarkdown({ profile }).prepare(markdown);
  const shift = markdown.length - prepared.length;
  const md = pipeline({ profile, blockAnchors: anchors.map((a) => ({ ...a, from: a.from - shift, to: a.to - shift })) });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}
/** Renders a note written the old way: its ids become anchors first. */
const render = (old: string, profile: MarkdownProfile = "published") => { const a = anchored(old); return html(a.markdown, profile, ondenMarkdown, a.anchors); };
/** id → the tag carrying data-block-id="id", in page order. */
const tagged = (out: string) => [...out.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-block-id="([^"]+)"/g)].map((m) => [m[2], m[1]]);

describe("block anchors (shared fixture)", () => {
  it("the fixture's text carries no ^id once converted, except inside code", () => {
    expect(legacy.markdown).not.toMatch(/\^(h1|p1|li1|list1|q2|q1|t1|tb|hb|h2)\b/);
    for (const id of fixture.inCode) expect(legacy.markdown).toContain(`^${id}`);
    expect(legacy.anchors.map((a) => a.id)).toEqual(expectedAnchors.map((a) => a.id));
  });

  it("legacyBlockAnchors (the migration's reader) finds every block's id, none in code", () => {
    expect(legacyBlockAnchors(note).map((a) => [a.id, a.kind])).toEqual(fixture.anchors.map((a) => [a.id, a.kind]));
  });

  it("anchoredBlocks puts each anchor on the same kind of block the old marks anchored", () => {
    expect(anchoredBlocks(legacy.markdown, legacy.anchors).map((b) => [b.id, b.kind])).toEqual(expectedAnchors.map((a) => [a.id, a.kind]));
  });

  it("a block node's ref is its anchor's, on the block the anchor starts", () => {
    const blocks = parseBlocks(legacy.markdown, legacy.anchors);
    expect(blocks.map((b) => b.ref)).toEqual(fixture.blockNodes.filter((id) => id !== "hb")); // `#tag` blocks are gone
    const spans = new Map(anchoredBlocks(legacy.markdown, legacy.anchors).map((a) => [a.id, a]));
    for (const b of blocks) expect(spans.get(b.ref!), b.ref!).toMatchObject({ start: b.start, end: b.end });
  });

  it("the old reading of the same note agrees on which blocks are block nodes", () => {
    expect(parseLegacyBlocks(note).map((b) => b.ref)).toEqual(fixture.blockNodes);
    expect(parseBlocks(note).map((b) => b.ref)).toEqual([]); // the ids in the text are plain text now
  });

  it.each(["published", "app"] as const)("the %s renderer tags each anchored block; no ^id is shown outside code", (profile) => {
    const out = html(legacy.markdown, profile, ondenMarkdown, legacy.anchors);
    expect(tagged(out)).toEqual(expectedAnchors.map((a) => [a.id, a.element]));
    for (const { id } of expectedAnchors) expect(out, id).not.toContain(`^${id}`);
    for (const id of fixture.inCode) expect(out, id).toContain(`^${id}`);
  });

  it.each(["published", "app"] as const)("the core pipeline (no enhancers) anchors the %s page the same way", (profile) => {
    const out = html(legacy.markdown, profile, (o) => ondenMarkdownCore(o), legacy.anchors);
    expect(tagged(out)).toEqual(expectedAnchors.map((a) => [a.id, a.element]));
    for (const { id } of expectedAnchors) expect(out, id).not.toContain(`^${id}`);
  });

  it.fails("KNOWN GAP: every anchor of the fixture is placed (`- nested ^li2` as a list item, `> quoted ^qp` as a paragraph)", () => {
    const all = anchored(note.replace("Hashtag line #topic ^hb", "Hashtag line ^hb"));
    expect(anchoredBlocks(all.markdown, all.anchors).map((b) => [b.id, b.kind])).toEqual(fixture.anchors.map((a) => [a.id, a.kind]));
  });

  it("an anchor on a list's only item tags the item, not the list", () => {
    expect(anchoredBlocks("- a", [{ id: "a", from: 0, to: 3 }]).map((b) => [b.id, b.kind])).toEqual([["a", "listItem"]]);
  });

  it("without anchors no block carries an id", () => {
    expect(tagged(html(legacy.markdown, "app"))).toEqual([]);
  });
});

describe("block anchors, case by case", () => {
  it("a list item's anchor tags the item; a `^id` in the text is shown as text", () => {
    expect(render("- item ^abc\n- other")).toContain('<li data-block-id="abc">item</li>');
    expect(html("- item ^abc\n- other")).toContain("item ^abc");
    expect(tagged(html("- item ^abc\n- other"))).toEqual([]);
  });

  it("a heading's anchor tags the heading, also with a closing ##", () => {
    expect(render("## Title ^h1")).toBe('<h2 id="user-content-title" data-block-id="h1">Title</h2>');
    expect(html("## Title ##", "published", ondenMarkdown, [{ id: "h1", from: 0, to: 11 }])).toBe('<h2 id="user-content-title" data-block-id="h1">Title</h2>');
  });

  it("a quote's anchor tags the blockquote (a callout: the div with its class)", () => {
    expect(render("> said\n\n^q")).toBe('<blockquote data-block-id="q">\n<p>said</p>\n</blockquote>');
    expect(render("> said\n> ^q")).toBe('<blockquote data-block-id="q">\n<p>said</p>\n</blockquote>');
    expect(render("> [!tip] T\n\n^c")).toContain('<div data-block-id="c" class="callout callout-tip">');
  });

  it("inside containers too: a quote in a list item, a paragraph in a quote", () => {
    const out = render("- item\n\n  > nested quote\n\n  ^nq\n\n> first\n>\n> inner ^ip");
    expect(tagged(out)).toEqual([["nq", "blockquote"], ["ip", "p"]]);
    expect(out).not.toMatch(/\^nq|\^ip/);
  });

  it("an anchor that no block starts at (its text moved) tags nothing", () => {
    expect(anchoredBlocks("text\n\nmore", [{ id: "lost", from: 2, to: 4 }])).toEqual([]);
    expect(html("text\n\nmore", "published", ondenMarkdown, [{ id: "lost", from: 2, to: 4 }])).toBe("<p>text</p>\n<p>more</p>");
  });

  it("where several blocks start at one place, the one the anchor ends with wins (a list and its first item)", () => {
    const md = "- a\n- b";
    expect(anchoredBlocks(md, [{ id: "l", from: 0, to: md.length }]).map((b) => [b.id, b.kind])).toEqual([["l", "list"]]);
    expect(anchoredBlocks(md, [{ id: "i", from: 0, to: 3 }]).map((b) => [b.id, b.kind])).toEqual([["i", "listItem"]]);
  });

  it("the first anchor of an id wins", () => {
    expect(anchoredBlocks("a\n\nb", [{ id: "x", from: 0, to: 1 }, { id: "x", from: 3, to: 4 }]).map((b) => b.start)).toEqual([0]);
  });

  it("an anchor survives typing before the block once its offsets move with the text", () => {
    const anchorsFor = (md: string) => [{ id: "k", from: md.indexOf("target"), to: md.indexOf("target") + 6 }];
    const a = "intro\n\ntarget";
    const b = "a much longer intro\n\ntarget";
    expect(tagged(html(a, "app", ondenMarkdown, anchorsFor(a)))).toEqual([["k", "p"]]);
    expect(tagged(html(b, "app", ondenMarkdown, anchorsFor(b)))).toEqual([["k", "p"]]);
  });

  it("ids in ~~~ and indented code are text, not anchors (the migration's reader skips them)", () => {
    expect(legacyBlockAnchors("~~~\nx ^a\n~~~\n\n    y ^b\n")).toEqual([]);
  });

  it("an id is the grammar's: a caret glued to a word, or 65 characters, is not one", () => {
    expect(legacyBlockAnchors("a^abc")).toEqual([]);
    expect(legacyBlockAnchors(`a ^${"x".repeat(65)}`)).toEqual([]);
    expect(legacyBlockAnchors(`a ^${"x".repeat(64)}`).map((a) => a.id)).toEqual(["x".repeat(64)]);
    expect(trailingBlockId("a ^b-1  ")).toEqual({ id: "b-1", start: 2, end: 6 });
    expect(trailingBlockId("^b")).toEqual({ id: "b", start: 0, end: 2 });
    expect(BLOCK_ID.test("a_b")).toBe(false);
  });

  it("an `^id` alone after a paragraph was never an anchor (the migration drops it as an orphan)", () => {
    expect(legacyBlockAnchors("text\n\n^lone")).toEqual([]);
  });
});

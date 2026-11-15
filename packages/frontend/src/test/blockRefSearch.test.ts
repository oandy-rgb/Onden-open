import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listLinkTargets } from "@onden/markdown";
import {
  BLOCK_REF_NOTES, BLOCK_REF_ROWS, blockRefRows, createTargetCache, findBlockRefs, recentRows, withoutListed,
  type BlockRefRow, type BlockRefSources, type NoteForRefs,
} from "../lib/blockRefSearch";
import { anchored } from "./helpers/anchoredText";
import { applyCompletion, getCompletions, type CompletionContext } from "../lib/editorCompletion";

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; vi.restoreAllMocks(); });
function editor(doc: string, caret = doc.length) {
  view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: caret } }) });
  return view;
}
const note = (id: string, over: Partial<NoteForRefs> = {}): NoteForRefs => ({ id, title: id.toUpperCase(), sameNote: false, writable: true, ...over });
// The fixtures write a paragraph's id the old way (`text ^id`); targetsOf reads it as the anchor it became.
const targetsOf = (legacy: string) => { const { markdown, anchors } = anchored(legacy); return listLinkTargets(markdown, anchors); };
const rowsOf = (md: string, filter = "", over: Partial<NoteForRefs> = {}) => blockRefRows(filter, targetsOf(md), note("t", { title: "Target", ...over }), "found");
const ctx = (extra: Partial<CompletionContext>): CompletionContext => ({
  nodes: [{ id: "t", title: "Target" }], tags: [], attrClassTags: [], canSetAttr: false, canInsertPage: false, canCreateNote: false, ...extra,
});

describe("block rows", () => {
  it("find paragraphs and headings by their words, marking the match in the shown text", () => {
    const rows = rowsOf("# Binary search\n\nThe quick brown fox\n\nunrelated", "quick");
    expect(rows.map((r) => r.snippet.text)).toEqual(["The quick brown fox"]);
    const { text, ranges } = rows[0]!.snippet;
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(["quick"]);
    expect(rowsOf("# Binary search\n\nx", "binary")[0]!.target.kind).toBe("heading");
  });

  it("show the words around a match far into a long paragraph", () => {
    const long = `${"filler ".repeat(40)}needle ${"tail ".repeat(40)}`;
    const [row] = rowsOf(long, "needle");
    expect(row!.snippet.text.startsWith("…")).toBe(true);
    expect(row!.snippet.text.length).toBeLessThan(100);
    expect(row!.snippet.text.startsWith("…filler")).toBe(true); // a whole word, never "…ller"
    expect(row!.snippet.ranges.map(([a, b]) => row!.snippet.text.slice(a, b))).toEqual(["needle"]);
  });

  it("always name their note, even inside the open note", () => {
    const [row] = blockRefRows("", targetsOf("claim ^c1"), note("t", { title: "Target", sameNote: true }), "recent");
    expect(row!.short).toBe(false);
  });
});

describe("recentRows", () => {
  const at = (n: number) => n;
  const read = (id: string) => id === "gone" ? null : { note: note(id), targets: targetsOf("first ^a1\n\nsecond ^b2\n\nno id") };
  it("lists each remembered paragraph in order, dropping a gone note or paragraph", () => {
    const rows = recentRows([
      { note: "n1", ref: "b2", at: at(3) }, { note: "gone", ref: "a1", at: at(2) }, { note: "n2", ref: "missing", at: at(2) }, { note: "n2", ref: "a1", at: at(1) },
    ], read, "");
    expect(rows.map((r) => [r.noteId, r.snippet.text, r.origin])).toEqual([["n1", "second", "recent"], ["n2", "first", "recent"]]);
  });
  it("finds a paragraph remembered by its words, also once it has an anchor", () => {
    const pending = { text: "second", blockKind: "paragraph" as const, start: 10 };
    expect(recentRows([{ note: "n1", ref: "x", at: 1, pending }], read, "").map((r) => r.snippet.text)).toEqual(["second"]);
    const unanchored = (id: string) => ({ note: note(id), targets: listLinkTargets("first\n\nsecond") });
    expect(recentRows([{ note: "n1", ref: "x", at: 1, pending }], unanchored, "").map((r) => r.snippet.text)).toEqual(["second"]);
  });
  it("narrows by the typed words", () => {
    const rows = recentRows([{ note: "n1", ref: "a1", at: 2 }, { note: "n1", ref: "b2", at: 1 }], read, "seco");
    expect(rows.map((r) => r.snippet.text)).toEqual(["second"]);
  });
  it("withoutListed drops a found row already listed as recent", () => {
    const recent = recentRows([{ note: "n1", ref: "a1", at: 1 }], read, "");
    const found = blockRefRows("", read("n1")!.targets, note("n1"), "found");
    expect(withoutListed(found, recent).map((r) => r.snippet.text)).toEqual(["second", "no id"]);
  });
});

describe("findBlockRefs", () => {
  const bodies: Record<string, string> = {
    a: "alpha paragraph about graphs\n\nother", b: "# Graphs\n\nnothing here", c: "a graph of c",
    cur: "my own graph note",
  };
  function sources(over: Partial<BlockRefSources> = {}) {
    const cache = createTargetCache();
    const parsed = vi.fn();
    const search = vi.fn(over.search ?? (async () => [{ id: "a" }, { id: "b" }, { id: "hidden" }, { id: "c" }]));
    const src: BlockRefSources = {
      note: (id) => id === "hidden" ? null : note(id, { sameNote: id === "cur" }),
      body: async (id) => bodies[id] ?? null,
      targets: (id, body) => { parsed(id); return cache(id, body); },
      current: null,
      ...over,
      search,
    };
    return Object.assign(src, { parsed });
  }

  it("asks the index once, cuts only the notes it names, skips one the reader cannot see", async () => {
    const src = sources();
    const rows = await findBlockRefs("graph", src);
    expect(src.search).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => [r.noteId, r.snippet.text])).toEqual([
      ["a", "alpha paragraph about graphs"], ["b", "Graphs"], ["c", "a graph of c"],
    ]);
    expect(src.parsed).toHaveBeenCalledTimes(3);
  });

  it("keeps the cut paragraphs while the text is the same", async () => {
    const cache = createTargetCache(2);
    const first = cache("a", bodies.a!);
    expect(cache("a", bodies.a!)).toBe(first);
    expect(cache("a", `${bodies.a} edited`)).not.toBe(first);
    cache("b", bodies.b!); cache("c", bodies.c!); // over its size: the oldest goes
    expect(cache("a", `${bodies.a} edited`)).toEqual(listLinkTargets(`${bodies.a} edited`));
  });

  it("searches the open note's own text first, even when the index has not caught up", async () => {
    const src = sources({ current: { id: "cur", text: () => "typed just now: graph" } });
    const rows = await findBlockRefs("graph", src);
    expect(rows[0]!.noteId).toBe("cur");
    expect(rows[0]!.sameNote).toBe(true);
    expect(rows[0]!.snippet.text).toContain("graph");
  });

  it("limits the notes it reads and the rows it returns", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `n${i}`);
    const read = vi.fn(async () => Array.from({ length: 10 }, (_, i) => `graph ${i}`).join("\n\n"));
    const src = sources({ search: async () => many.map((id) => ({ id })), note: (id) => note(id), body: read });
    const rows = await findBlockRefs("graph", src);
    expect(read).toHaveBeenCalledTimes(BLOCK_REF_NOTES);
    expect(rows).toHaveLength(BLOCK_REF_ROWS);
  });

  it("returns nothing for nothing typed and skips a note whose text cannot be read", async () => {
    const src = sources();
    expect(await findBlockRefs("  ", src)).toEqual([]);
    expect(src.search).not.toHaveBeenCalled();
    const rows = await findBlockRefs("graph", sources({ body: async (id) => (id === "a" ? null : bodies[id] ?? null) }));
    expect(rows.map((r) => r.noteId)).toEqual(["b", "c"]);
  });
});

describe("the lists", () => {
  const rows = rowsOf("claim ^c1");
  it("`((` offers the found rows as they are", () => {
    expect(getCompletions({ type: "blockref", query: "cl" }, ctx({ blockRefs: rows }))).toEqual(rows);
    expect(getCompletions({ type: "blockref", query: "" }, ctx({}))).toEqual([]);
  });
  it("the plain `[[` list puts 「最近存的段落」 above the notes, and leaves `[[Note#` alone", () => {
    const recent = recentRows([{ note: "t", ref: "c1", at: 1 }], () => ({ note: note("t"), targets: targetsOf("claim ^c1") }), "");
    const list = getCompletions({ type: "wikilink", query: "Tar" }, ctx({ recentBlocks: recent }));
    expect(list[0]).toBe(recent[0]);
    expect((list[1] as { id: string }).id).toBe("t");
    const targets = rowsOf("x");
    expect(getCompletions({ type: "wikilink", query: "Target#" }, ctx({ recentBlocks: recent, linkTargets: targets }))).toEqual(targets);
  });
});

describe("choosing a row", () => {
  const apply = (v: EditorView, row: BlockRefRow, start: number) => applyCompletion(v, { type: "blockref", triggerStart: start }, row);

  it("(( writes [[Note/words]] over the trigger, whether or not the paragraph has an old ^id", () => {
    const v = editor("see ((cla");
    expect(apply(v, rowsOf("claim ^c1")[0]!, 4)).toMatchObject({ kind: "bind-part-link", noteId: "t" });
    expect(v.state.doc.toString()).toBe("see [[Target/claim]]");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it("!(( writes the embed, and a heading is named by its text", () => {
    const v = editor("see !((cla");
    const next = apply(v, rowsOf("claim ^c1")[0]!, 4);
    expect(v.state.doc.toString()).toBe("see ![[Target/claim]]");
    expect(next).toMatchObject({ kind: "bind-part-link", link: "![[Target/claim]]", embed: true });
    const h = editor("((big");
    apply(h, rowsOf("# Big Idea\n\nx", "big")[0]!, 0);
    expect(h.state.doc.toString()).toBe("[[Target/Big Idea]]");
  });

  it("no id is made anywhere: the follow-up asks the server to anchor and bind the part", () => {
    const v = editor("!((no");
    const next = apply(v, rowsOf("no id yet")[0]!, 0);
    expect(v.state.doc.toString()).toBe("![[Target/no id yet]]");
    expect(next).toMatchObject({ kind: "bind-part-link", noteId: "t", link: "![[Target/no id yet]]", text: "no id yet", target: { text: "no id yet" } });
  });

  it("a paragraph of the open note is linked as [[/words]], and the paragraph itself is not touched", () => {
    const doc = "first line\n\nsecond para\n\n((sec";
    const v = editor(doc);
    // Listed from the open note's own text, as the hook does.
    const row = rowsOf("first line\n\nsecond para", "sec", { sameNote: true })[0]!;
    expect(apply(v, row, doc.indexOf("(("))).toMatchObject({ kind: "bind-part-link" });
    expect(v.state.doc.toString()).toBe("first line\n\nsecond para\n\n[[/second para]]");
  });

  it("a note the reader cannot edit still gets the part link: it reads by its words and needs no write", () => {
    const v = editor("!((no");
    const next = apply(v, rowsOf("no id yet", "", { writable: false })[0]!, 0);
    expect(v.state.doc.toString()).toBe("![[Target/no id yet]]");
    expect(next).toMatchObject({ kind: "bind-part-link" });
  });
});

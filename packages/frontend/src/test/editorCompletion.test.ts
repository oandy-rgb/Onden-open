import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { applyCompletion, detectPopupTrigger, getCompletions, type CompletionContext, type CompletionItem, type SlashItem } from "../lib/editorCompletion";
import type { Tag } from "../lib/api";

// The editor's typed completions, without the editor component: what each
// trigger offers and what picking a row writes into a real CodeMirror view.

const ctx = (over: Partial<CompletionContext> = {}): CompletionContext => ({
  nodes: [{ id: "n1", title: "Café notes" }, { id: "n2", title: "Heading tricks" }, { id: "n3", title: "Unrelated" }],
  tags: [{ id: "t1", name: "work" }, { id: "t2", name: "worldbuilding" }, { id: "t3", name: "home" }],
  attrClassTags: [], canSetAttr: false, canInsertPage: false, canCreateNote: false, ...over,
});

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });
/** A view holding `doc` with the caret at its end. */
function editor(doc: string) {
  view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.length } }) });
  return view;
}

describe("getCompletions", () => {
  it("/ lists formatting rows by the shared title rule, in declared order", () => {
    const titles = getCompletions({ type: "slash", query: "h2" }, ctx()).map((i) => (i as SlashItem).title);
    expect(titles[0]).toBe("Heading 2");
    expect(getCompletions({ type: "slash", query: "" }, ctx()).length).toBeGreaterThan(10);
  });

  it("/ offers page inserts only when the host can make pages, and field rows only with a setter", () => {
    const has = (c: CompletionContext, title: string) => getCompletions({ type: "slash", query: "" }, c).some((i) => (i as SlashItem).title === title);
    expect(has(ctx(), "Image, audio or video")).toBe(true);
    expect(has(ctx(), "PDF")).toBe(false);
    expect(has(ctx({ canInsertPage: true }), "PDF")).toBe(true);
    const book = { id: "b", name: "book", schema_fields: [{ name: "author", type: "text" }] } as unknown as Tag;
    const fieldRow = (c: CompletionContext) => getCompletions({ type: "slash", query: "" }, c).find((i) => (i as SlashItem).kind === "attr");
    expect(fieldRow(ctx({ attrClassTags: [book] }))).toBeUndefined();
    expect(fieldRow(ctx({ attrClassTags: [book], canSetAttr: true }))).toMatchObject({ kind: "attr", tagName: "book" });
  });

  it("/ template rows write the template's text only, with its dates filled, and say so (D69)", () => {
    const [row] = getCompletions({ type: "slash", query: "Template text: Meeting" }, ctx()) as SlashItem[];
    expect(row.title).toBe("Template text: Meeting notes");
    // Text, not a follow-up: picking it does not tag the note or set fields.
    expect(row.kind).toBeUndefined();
    const text = (row as Extract<SlashItem, { text: string }>).text;
    expect(text).toContain("## Action items");
    expect(text).not.toMatch(/\{date(time)?\}/);
    const v = editor("/meet");
    expect(applyCompletion(v, { type: "slash", triggerStart: 0 }, row)).toBeNull();
    expect(v.state.doc.toString()).toBe(text);
  });

  it("/daily and /meeting (a bare word) put their template row first, so Enter picks it", () => {
    const titles = (query: string) => (getCompletions({ type: "slash", query }, ctx()) as SlashItem[]).map((i) => i.title);
    expect(titles("daily")[0]).toBe("Template text: Daily note");
    expect(titles("meeting")[0]).toBe("Template text: Meeting notes"); // fuzzy: Reading notes may follow
  });

  it("[[ ranks notes with accents ignored, and offers to create a missing one", () => {
    expect(getCompletions({ type: "wikilink", query: "cafe" }, ctx())).toEqual([{ id: "n1", title: "Café notes", ranges: [[0, 4]] }]);
    expect(getCompletions({ type: "wikilink", query: "Brand new" }, ctx({ canCreateNote: true })))
      .toEqual([{ __create: "note", query: "Brand new" }]);
    expect(getCompletions({ type: "wikilink", query: "Brand new" }, ctx())).toEqual([]);
  });

  it("{ never suggests a hidden tag, except for its full name (D104)", () => {
    const tags = [{ id: "t1", name: "work" }, { id: "t9", name: "workshop", hidden: true }];
    expect(getCompletions({ type: "blocktag", query: "wor" }, ctx({ tags }))).toEqual([{ id: "t1", name: "work" }]);
    expect(getCompletions({ type: "blocktag", query: "workshop" }, ctx({ tags }))).toEqual([tags[1]]);
    expect(getCompletions({ type: "blocktag", query: "" }, ctx({ tags }))).toEqual([tags[0]]);
    expect(getCompletions({ type: "blocktag", query: "WorkShop" }, ctx({ tags }))).toEqual([tags[1]]);
  });

});

describe("applyCompletion", () => {
  it("a / row replaces the line's command and puts the caret inside the block", () => {
    const v = editor("/code");
    const code = getCompletions({ type: "slash", query: "code" }, ctx())[0];
    expect(applyCompletion(v, { type: "slash", triggerStart: 0 }, code)).toBeNull();
    expect(v.state.doc.toString()).toBe("```\n\n```");
    expect(v.state.selection.main.head).toBe(4);
  });

  it("[[ and { rows write the link or tag over the trigger", () => {
    const v = editor("see [[caf");
    applyCompletion(v, { type: "wikilink", triggerStart: 4 }, { id: "n1", title: "Café notes" });
    expect(v.state.doc.toString()).toBe("see [[Café notes]]");
    const w = editor("tagged {wo");
    applyCompletion(w, { type: "blocktag", triggerStart: 8 }, { id: "t1", name: "work" });
    expect(w.state.doc.toString()).toBe("tagged {work}");
  });

  it("rows that need the page clear the trigger and hand back what to do", () => {
    const v = editor("x\n/pdf");
    const pdf = getCompletions({ type: "slash", query: "pdf" }, ctx({ canInsertPage: true }))[0];
    expect(applyCompletion(v, { type: "slash", triggerStart: 2 }, pdf)).toEqual({ kind: "insert", insert: "pdf", at: 2 });
    expect(v.state.doc.toString()).toBe("x\n");
    const w = editor("[[New idea");
    const create: CompletionItem = { __create: "note", query: "New idea " };
    expect(applyCompletion(w, { type: "wikilink", triggerStart: 0 }, create)).toEqual({ kind: "create-note", title: "New idea", triggerStart: 0 });
    expect(w.state.doc.toString()).toBe("[[New idea");
  });
});

describe("block tags: `{` at the end of a block (B2b)", () => {
  it("opens once a name has started", () => {
    expect(detectPopupTrigger("二分搜尋 {考")).toEqual({ type: "blocktag", query: "考", markerIndex: 6 });
    expect(detectPopupTrigger("text {a, wo")).toMatchObject({ type: "blocktag", query: "wo" });
    // A lone `{` (Enter must stay a newline), a closed one, code, attributes.
    expect(detectPopupTrigger("text {")).toBeNull();
    expect(detectPopupTrigger("text {a} more")).toBeNull();
    expect(detectPopupTrigger("use {x", true)).toBeNull();
    expect(detectPopupTrigger("text \\{lit")).toBeNull();
    expect(detectPopupTrigger("text {status: dr")).toBeNull();
  });

  it("offers existing names containing the query", () => {
    expect(getCompletions({ type: "blocktag", query: "or" }, ctx()).map((i) => (i as { name: string }).name)).toEqual(["work", "worldbuilding"]);
  });

  it("writes the name and closes the brace unless one follows", () => {
    const v = editor("item {wo");
    applyCompletion(v, { type: "blocktag", triggerStart: 6 }, { id: "t1", name: "work" });
    expect(v.state.doc.toString()).toBe("item {work}");
    const w = editor("item {a, wo");
    w.dispatch({ changes: { from: w.state.doc.length, insert: "}" }, selection: { anchor: w.state.doc.length } });
    applyCompletion(w, { type: "blocktag", triggerStart: 9 }, { id: "t1", name: "work" });
    expect(w.state.doc.toString()).toBe("item {a, work}");
  });
});

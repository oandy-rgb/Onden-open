import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listLinkTargets } from "@onden/markdown";
import { applyCompletion, getCompletions, type CompletionContext } from "../lib/editorCompletion";
import { targetRows, type LinkTargetRow } from "../lib/wikilinkTargets";

// Picking a row of the `[[Note#` popup: the part link written by the paragraph's words, nothing
// marked in any note, and the host told to bind the link to the paragraph.

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });
function editor(doc: string, caret = doc.length) {
  view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: caret } }) });
  return view;
}
const query = { filter: "", blocksOnly: false, noteTyped: true };
const rowsOf = (md: string, over: Partial<Parameters<typeof targetRows>[2]> = {}, q = query) =>
  targetRows(q, listLinkTargets(md), { id: "t", title: "Target", sameNote: false, writable: true, ...over });
const ctx = (linkTargets: LinkTargetRow[]): CompletionContext => ({
  nodes: [{ id: "t", title: "Target" }], tags: [], attrClassTags: [], canSetAttr: false, canInsertPage: false, canCreateNote: false, linkTargets,
});

describe("[[Note# rows", () => {
  it("getCompletions offers the target rows instead of the note list", () => {
    const rows = rowsOf("# H\n\npara");
    expect(getCompletions({ type: "wikilink", query: "Target#" }, ctx(rows))).toEqual(rows);
    expect(getCompletions({ type: "wikilink", query: "Targ" }, { ...ctx([]), linkTargets: undefined }).map((i) => (i as { id: string }).id)).toEqual(["t"]);
  });

  it("a heading inserts [[Note/Heading]] and asks the host to bind it", () => {
    const v = editor("see [[Target#");
    const next = applyCompletion(v, { type: "wikilink", triggerStart: 4 }, rowsOf("# Big Idea\n\nx")[0]!);
    expect(v.state.doc.toString()).toBe("see [[Target/Big Idea]]");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    expect(next).toMatchObject({ kind: "bind-part-link", noteId: "t", target: { start: 0, text: "Big Idea" }, link: "[[Target/Big Idea]]", text: "Big Idea", embed: false });
  });

  it("a paragraph is linked by the start of its words, whether or not it has an old ^id; no id is made", () => {
    const v = editor("[[Target#^");
    const next = applyCompletion(v, { type: "wikilink", triggerStart: 0 }, rowsOf("claim ^c1")[0]!);
    expect(v.state.doc.toString()).toBe("[[Target/claim]]");
    expect(next).toMatchObject({ kind: "bind-part-link", noteId: "t", link: "[[Target/claim]]" });
    const v2 = editor("[[Target#^");
    applyCompletion(v2, { type: "wikilink", triggerStart: 0 }, rowsOf("no id yet")[0]!);
    expect(v2.state.doc.toString()).toBe("[[Target/no id yet]]");
  });

  it("words that hold / | [ ] are cleaned so the link stays one link", () => {
    const v = editor("[[Target#^");
    applyCompletion(v, { type: "wikilink", triggerStart: 0 }, rowsOf("a/b | [c] d")[0]!);
    expect(v.state.doc.toString()).toBe("[[Target/a b c d]]");
  });

  it("a part with no words gets the plain note link", () => {
    const v = editor("[[Target#");
    const row = { ...rowsOf("# x")[0]!, target: { kind: "heading" as const, text: "/", depth: 1 as const, start: 0 } };
    expect(applyCompletion(v, { type: "wikilink", triggerStart: 0 }, row)).toBeNull();
    expect(v.state.doc.toString()).toBe("[[Target]]");
  });

  it("[[#^ in the same note writes [[/words]] in one transaction, and nothing is added to the paragraph", () => {
    const doc = "First point\n\nSecond point\n\n[[#^";
    const v = editor(doc);
    const rows = rowsOf(doc, { id: "cur", title: "Current", sameNote: true }, { filter: "", blocksOnly: true, noteTyped: false })
      .filter((r) => r.target.kind === "block" && r.target.text === "First point");
    expect(rows[0]!.short).toBe(true);
    let dispatches = 0;
    const dispatch = v.dispatch.bind(v);
    v.dispatch = ((...args: Parameters<EditorView["dispatch"]>) => { dispatches++; return dispatch(...args); }) as EditorView["dispatch"];
    const next = applyCompletion(v, { type: "wikilink", triggerStart: doc.indexOf("[[#^") }, rows[0]!);
    expect(dispatches).toBe(1);
    expect(v.state.doc.toString()).toBe("First point\n\nSecond point\n\n[[/First point]]");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    expect(next).toMatchObject({ kind: "bind-part-link", noteId: "cur", link: "[[/First point]]" });
  });

  it("a ! typed before [[ stays: the pick is an embed of the part", () => {
    const v = editor("![[Target#^");
    const next = applyCompletion(v, { type: "wikilink", triggerStart: 1 }, rowsOf("embed me")[0]!);
    expect(v.state.doc.toString()).toBe("![[Target/embed me]]");
    expect(next).toMatchObject({ kind: "bind-part-link", link: "[[Target/embed me]]" });
  });
});

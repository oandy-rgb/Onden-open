import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldable, foldedRanges, unfoldEffect } from "@codemirror/language";
import { SearchQuery, findNext, search, setSearchQuery } from "@codemirror/search";
import { applyFoldMarks, foldAllHeadings, headingFoldKeymap, foldMarks, headingFolding, headingLines, revealFolded, unfoldAllHeadings, type FoldMark } from "./editorFold";
import { editorFrontmatter } from "./editorFrontmatter";
import { revealRange } from "./editorFind";

const External = Annotation.define<boolean>();
const views: EditorView[] = [];
function mount(doc: string, save: (marks: FoldMark[]) => void = () => {}) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), editorFrontmatter, headingFolding(save, External), search()] }),
  });
  views.push(view);
  return view;
}
afterEach(() => { views.splice(0).forEach((v) => { v.destroy(); v.dom.parentElement?.remove(); }); });

const NOTE = [
  "# One", "intro", "## One.A", "a text", "### One.A.1", "deep", "## One.B", "b text", "# Two", "two text",
].join("\n");
const rangeText = (view: EditorView, r: { from: number; to: number } | null) => (r ? view.state.sliceDoc(r.from, r.to) : null);
const heading = (view: EditorView, text: string) => headingLines(view.state).find((h) => h.text === text)!;
const foldOf = (view: EditorView, text: string) => { const h = heading(view, text); return foldable(view.state, h.from, h.to); };
const foldedTexts = (view: EditorView) => {
  const out: string[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (a, b) => { out.push(view.state.sliceDoc(a, b)); });
  return out;
};

describe("heading sections", () => {
  it("a heading folds down to the next heading of the same or a higher level", () => {
    const view = mount(NOTE);
    expect(rangeText(view, foldOf(view, "# One"))).toBe("\nintro\n## One.A\na text\n### One.A.1\ndeep\n## One.B\nb text");
    expect(rangeText(view, foldOf(view, "## One.A"))).toBe("\na text\n### One.A.1\ndeep");
    expect(rangeText(view, foldOf(view, "### One.A.1"))).toBe("\ndeep");
    expect(rangeText(view, foldOf(view, "# Two"))).toBe("\ntwo text");
  });

  it("a heading with nothing under it has no fold", () => {
    const view = mount("# Alone\n\n# Next\ntext");
    expect(foldOf(view, "# Alone")).toBeNull();
  });

  it("a # line inside a code block is not a heading", () => {
    const view = mount("# Real\n```sh\n# comment\nls\n```\ntail\n# Next\nx");
    expect(headingLines(view.state).map((h) => h.text)).toEqual(["# Real", "# Next"]);
    expect(rangeText(view, foldOf(view, "# Real"))).toContain("# comment");
  });

  it("the frontmatter block is not a heading, and its lines get no arrow", () => {
    const view = mount("---\ndescription: x\n---\n# Title\nbody");
    expect(headingLines(view.state).map((h) => h.text)).toEqual(["# Title"]);
    expect(view.dom.querySelectorAll(".cm-fold-head")).toHaveLength(1);
  });
});

describe("folding and unfolding", () => {
  it("folds every heading with a section, and unfolds them all, leaving the text alone", () => {
    const view = mount(NOTE);
    foldAllHeadings(view);
    expect(foldedTexts(view).length).toBe(5);
    expect(view.state.doc.toString()).toBe(NOTE);
    unfoldAllHeadings(view);
    expect(foldedTexts(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it("draws the arrow class on foldable headings and the closed one when folded", () => {
    const view = mount(NOTE);
    expect(view.dom.querySelectorAll(".cm-fold-open").length).toBe(5);
    foldAllHeadings(view);
    expect(view.dom.querySelectorAll(".cm-fold-closed").length).toBeGreaterThan(0);
    expect(view.dom.querySelector(".cm-foldPlaceholder")?.textContent).toBe("…");
  });

  it("a press on the arrow after a heading toggles it; a press on its text does not", () => {
    const view = mount(NOTE);
    // jsdom has no layout: say where the heading's text ends.
    const proto = Range.prototype as unknown as { getClientRects?: () => unknown[] };
    proto.getClientRects = () => [{ left: 90, right: 100, top: 0, bottom: 20 }];
    onTestFinished(() => { delete proto.getClientRects; });
    vi.spyOn(view, "posAndSideAtCoords").mockReturnValue({ pos: 0, assoc: 1 }); // a press on the text is CodeMirror's
    const press = (clientX: number) => view.dom.querySelector<HTMLElement>(".cm-fold-head")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX, clientY: 10, button: 0 }));
    press(50);
    expect(foldedTexts(view)).toEqual([]);
    press(104);
    expect(foldedTexts(view).length).toBe(1);
    press(104);
    expect(foldedTexts(view)).toEqual([]);
  });

  it("the 「…」 chip unfolds", () => {
    const view = mount(NOTE);
    foldAllHeadings(view);
    view.dom.querySelector<HTMLElement>(".cm-foldPlaceholder")!.click();
    expect(foldedTexts(view).length).toBeLessThan(5);
  });
});

describe("opening itself", () => {
  it("unfolds when the caret goes inside", () => {
    const view = mount(NOTE);
    foldAllHeadings(view);
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("a text") } });
    expect(foldedTexts(view).some((t) => t.includes("a text"))).toBe(false);
  });

  it("moves a caret hidden by a fold to the heading", () => {
    const view = mount(NOTE);
    view.dispatch({ selection: { anchor: NOTE.indexOf("two text") } });
    foldAllHeadings(view);
    expect(view.state.selection.main.head).toBe(heading(view, "# Two").to);
  });

  it("unfolds for a search hit", () => {
    const view = mount(NOTE);
    foldAllHeadings(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "deep" })) });
    findNext(view);
    expect(foldedTexts(view).some((t) => t.includes("deep"))).toBe(false);
  });

  it("unfolds for a jump that scrolls without moving the caret", () => {
    const view = mount(NOTE);
    foldAllHeadings(view);
    const at = NOTE.indexOf("b text");
    revealRange(view, { from: at, to: at + 6 });
    expect(foldedTexts(view).some((t) => t.includes("b text"))).toBe(false);
    foldAllHeadings(view);
    revealFolded(view, NOTE.indexOf("two text"));
    expect(foldedTexts(view).some((t) => t.includes("two text"))).toBe(false);
  });
});

describe("remembering folds", () => {
  it("names folded headings by text and which of the same text, and puts them back", () => {
    const text = "# A\nx\n# B\ny\n# A\nz";
    const view = mount(text);
    foldAllHeadings(view);
    const marks = foldMarks(view.state);
    expect(marks).toEqual([{ text: "# A", nth: 0 }, { text: "# B", nth: 0 }, { text: "# A", nth: 1 }]);
    const other = mount(text);
    applyFoldMarks(other, [{ text: "# A", nth: 1 }]);
    expect(foldedTexts(other)).toEqual(["\nz"]);
  });

  it("drops a mark whose heading is gone, without an error", () => {
    const view = mount("# Kept\nx\n# Other\ny");
    applyFoldMarks(view, [{ text: "# Deleted", nth: 0 }, { text: "# Kept", nth: 3 }, { text: "# Other", nth: 0 }]);
    expect(foldedTexts(view)).toEqual(["\ny"]);
  });

  it("applyFoldMarks replaces what was folded", () => {
    const view = mount(NOTE);
    foldAllHeadings(view);
    applyFoldMarks(view, [{ text: "# Two", nth: 0 }]);
    expect(foldedTexts(view)).toEqual(["\ntwo text"]);
  });

  it("saves after the person folds or unfolds, not after a restore or the host replacing the text", () => {
    const save = vi.fn();
    const view = mount(NOTE, save);
    applyFoldMarks(view, [{ text: "# Two", nth: 0 }]);
    expect(save).not.toHaveBeenCalled();
    foldAllHeadings(view);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toHaveLength(5);
    save.mockClear();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# New\ntext" }, annotations: External.of(true) });
    expect(save).not.toHaveBeenCalled();
    foldAllHeadings(view);
    save.mockClear();
    unfoldAllHeadings(view);
    expect(save).toHaveBeenLastCalledWith([]);
  });

  it("keeps a fold of an unrelated heading when text elsewhere is edited", () => {
    const view = mount("# A\nx\n# B\ny");
    applyFoldMarks(view, [{ text: "# B", nth: 0 }]);
    view.dispatch({ changes: { from: 0, insert: "intro\n" } });
    expect(foldMarks(view.state)).toEqual([{ text: "# B", nth: 0 }]);
    expect(unfoldEffect).toBeDefined();
  });
});

describe("keys", () => {
  it("binds nothing with Ctrl+Alt, which AltGr keyboards use to type [ and ]", () => {
    for (const binding of headingFoldKeymap) {
      for (const chord of [binding.key, binding.mac]) expect(/(?:Ctrl|Mod)-Alt|Alt-Ctrl/.test(chord)).toBe(false);
    }
  });

  it("folds only the heading's section at the caret, never a paragraph, and unfolds it", () => {
    const view = mount(NOTE);
    view.dispatch({ selection: { anchor: NOTE.indexOf("a text") } });
    expect(foldKey(view, 0)).toBe(true);
    expect(foldedTexts(view)).toEqual(["\na text\n### One.A.1\ndeep"]);
    expect(foldKey(view, 1)).toBe(true);
    expect(foldedTexts(view)).toEqual([]);
    view.dispatch({ selection: { anchor: 0 }, changes: { from: 0, insert: "plain\n\n" } });
    expect(foldKey(createPlain(), 0)).toBe(false);
  });

  it("typing next to a folded heading's chip keeps the text and the fold", () => {
    const view = mount(NOTE);
    applyFoldMarks(view, [{ text: "## One.A", nth: 0 }]);
    const at = NOTE.indexOf("## One.A") + "## One.A".length;
    view.dispatch({ changes: { from: at, insert: "字" }, selection: { anchor: at + 1 }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("## One.A字");
    expect(foldedTexts(view)).toHaveLength(1);
  });
});
const foldKey = (view: EditorView, which: 0 | 1) => headingFoldKeymap[which]!.run(view);
function createPlain() { return mount("no headings here"); }

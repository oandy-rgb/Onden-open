import { describe, it, expect } from "vitest";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseFrontmatter, stripFrontmatter } from "@onden/markdown";
import { editorFrontmatter } from "../lib/editorFrontmatter";

describe("parseFrontmatter", () => {
  it("parses simple key: value lines, trimming quotes", () => {
    const md = `---\ndescription: A custom SEO blurb\ntitle: "Quoted Title"\nslug: 'x'\n---\n\n# Body`;
    expect(parseFrontmatter(md)).toEqual({ description: "A custom SEO blurb", title: "Quoted Title", slug: "x" });
  });

  it("lowercases keys and ignores non key:value lines", () => {
    expect(parseFrontmatter("---\nDescription: hi\njust prose\n---\nbody")).toEqual({ description: "hi" });
  });

  it("returns {} when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\n\nbody")).toEqual({});
    expect(parseFrontmatter("")).toEqual({});
  });

  it("stripFrontmatter removes the block so the auto-description skips it", () => {
    expect(stripFrontmatter("---\ndescription: meta\n---\n\nFirst real paragraph.").trim())
      .toBe("First real paragraph.");
  });
});

// Typing next to a collapsed frontmatter block must not break its fence lines (a phone's tap on the
// chip puts the caret there): `--- text` is no fence, and the YAML lines turned into a heading.
describe("editorFrontmatter keeps the fences whole", () => {
  const open = (doc: string) => new EditorView({ state: EditorState.create({ doc, extensions: [editorFrontmatter] }) });
  const doc = "---\naliases: [A]\ncreated: 2026-10-07\n---\nBody";

  it("text typed at the end of line 1 or of the closing fence goes on a line after the block", () => {
    for (const at of [0, 3, doc.indexOf("\n---") + 2, doc.indexOf("\nBody")]) {
      const view = open(doc);
      view.dispatch({ changes: { from: at, insert: "手機輸入" }, selection: { anchor: at + 4 }, userEvent: "input.type" });
      expect(view.state.doc.toString()).toBe("---\naliases: [A]\ncreated: 2026-10-07\n---\n手機輸入\nBody");
      expect(view.state.selection.main.head).toBe("---\naliases: [A]\ncreated: 2026-10-07\n---\n手機輸入".length);
    }
  });

  it("an edit inside the YAML (the block is open) and Enter after the fence are left alone", () => {
    const view = open(doc);
    view.dispatch({ effects: [], selection: { anchor: 6 }, userEvent: "select.pointer" });
    view.dispatch({ changes: { from: 15, insert: "x" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("aliases: [Ax]");
    const plain = open(doc);
    plain.dispatch({ changes: { from: doc.indexOf("\nBody"), insert: "\n" }, userEvent: "input" });
    expect(plain.state.doc.toString()).toBe("---\naliases: [A]\ncreated: 2026-10-07\n---\n\nBody");
  });

  it("a change that is not typing (synced from another device) stays where it was inserted", () => {
    const view = open("---\naliases: [A]\n---\nBody");
    const at = "---\naliases: [A]\n".length;
    const mark = Annotation.define<boolean>();
    view.dispatch({ changes: { from: at, insert: "  - b\n" }, annotations: [mark.of(true), Transaction.addToHistory.of(false)] });
    expect(view.state.doc.toString()).toBe("---\naliases: [A]\n  - b\n---\nBody");
  });
});

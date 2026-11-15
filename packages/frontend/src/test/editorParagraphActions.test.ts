import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import {
  canMoveToChild, childEmbedAt, copyBlockLink, insertBlockTag, newTagName, paragraphTagChoices, paragraphToMove, startWikilink,
} from "../lib/editorParagraphActions";
import { setEditorAnchors } from "../lib/editorAnchors";
import { editorAnchorsField } from "../lib/editorAnchors";
import { detectPopupTrigger, getCompletions, type TagItem } from "../lib/editorCompletion";

// What the ¶ menu and "# Tag" do to the paragraph the caret is in: each is one
// edit on the editor's own view, so its undo and its save carry it.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

function editor(doc: string, caret = 0) {
  const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [history(), editorAnchorsField] }), parent: document.body });
  return { view, text: () => view.state.doc.toString() };
}

const TAGS: TagItem[] = [
  { id: "1", name: "review" }, { id: "2", name: "idea" }, { id: "3", name: "Today", virtual: true }, { id: "4", name: "secret", hidden: true },
];

describe("tagging a paragraph", () => {
  it("writes {name} into the paragraph the position is in, not its neighbours", () => {
    const e = editor("first para\n\nsecond para\n\nthird", 15);
    expect(insertBlockTag(e.view, 15, "review")).toBe(true);
    expect(e.text()).toBe("first para\n\nsecond para {review}\n\nthird");
  });

  it("adds to an existing {…} and leaves a name it already has", () => {
    const e = editor("para {idea}", 2);
    insertBlockTag(e.view, 2, "review");
    expect(e.text()).toBe("para {idea, review}");
    insertBlockTag(e.view, 2, "REVIEW");
    expect(e.text()).toBe("para {idea, review}");
  });

  it("is one undo step, and never writes a #word", () => {
    const e = editor("para one\n\npara two", 3);
    expect(undoDepth(e.view.state)).toBe(0);
    insertBlockTag(e.view, 3, "idea");
    expect(undoDepth(e.view.state)).toBe(1);
    expect(e.text()).not.toContain("#");
    undo(e.view);
    expect(e.text()).toBe("para one\n\npara two");
  });

  it("refuses where there is no paragraph (code), writing nothing", () => {
    const e = editor("```\ncode\n```", 6);
    expect(insertBlockTag(e.view, 6, "idea")).toBe(false);
    expect(e.text()).toBe("```\ncode\n```");
  });

  it("offers the rows the { popup offers, and a new name only when it is a plain new one", () => {
    for (const query of ["", "re", "toda", "secret", "zzz"]) {
      const popup = getCompletions({ type: "blocktag", query }, {
        nodes: [], tags: TAGS, attrClassTags: [], canSetAttr: false, canInsertPage: false, canCreateNote: false,
      });
      expect(paragraphTagChoices(TAGS, query)).toEqual(popup);
    }
    expect(paragraphTagChoices(TAGS, "secret").map((t) => t.name)).toEqual(["secret"]); // hidden: exact name only
    expect(newTagName(TAGS, " #Fresh,{} ")).toBe("Fresh");
    expect(newTagName(TAGS, "REVIEW")).toBeNull();      // exists
    expect(newTagName(TAGS, "Today")).toBe("Today");    // virtual tags aren't offered by `{`, so it is new
    expect(newTagName(TAGS, "due: friday")).toBeNull(); // an attribute entry, not a tag
    expect(newTagName(TAGS, "  ")).toBeNull();
  });
});

describe("what 「變成子筆記」 moves", () => {
  const withAnchors = (doc: string, caret: number, anchors: Array<{ id: string; from: number; to: number }>) => {
    const e = editor(doc, caret);
    e.view.dispatch({ effects: setEditorAnchors.of(anchors) });
    return e;
  };

  it("a paragraph with an anchor is named by it, and nothing is written into the note", () => {
    const doc = "one\n\ntwo words {idea}";
    const e = withAnchors(doc, 6, [{ id: "k9", from: 5, to: doc.length }]);
    expect(paragraphToMove(e.view, 6)).toEqual({ ref: "k9", from: 5, to: doc.length, text: "two words {idea}" });
    expect(e.text()).toBe(doc);
  });

  it("one without an anchor is moved by its text and place", () => {
    const e = editor("one\n\ntwo words", 6);
    expect(paragraphToMove(e.view, 6)).toEqual({ ref: null, from: 5, to: 14, text: "two words" });
  });

  it("a list item and a heading with its section", () => {
    const item = editor("- item\n- other", 3);
    expect(paragraphToMove(item.view, 3)).toMatchObject({ ref: null, text: "- item" });
    const heading = editor("# Title\n\nbody\n\n# Next", 2);
    expect(paragraphToMove(heading.view, 2)?.text).toBe("# Title\n\nbody");
  });

  it("is null for code, a quote or a blank position", () => {
    expect(paragraphToMove(editor("```\nx\n```", 5).view, 5)).toBeNull();
    expect(paragraphToMove(editor("> quoted", 3).view, 3)).toBeNull();
  });
});

describe("copying a block link", () => {
  it("copies [[title/first words]] without writing anything into the note", async () => {
    const e = editor("hello world", 2);
    const write = vi.fn(async (_text: string) => {});
    const result = await copyBlockLink(e.view, 2, "My note", write);
    expect(e.text()).toBe("hello world");
    expect(result).toEqual({ link: "[[My note/hello world]]", copied: true });
    expect(write).toHaveBeenCalledWith("[[My note/hello world]]");
  });

  it("a `^abc12` at the end is plain text now: neither read as an id nor written", async () => {
    const e = editor("hello world ^abc12", 2);
    const result = await copyBlockLink(e.view, 2, "My note", vi.fn(async () => {}));
    expect(result?.copied).toBe(true);
    expect(e.text()).toBe("hello world ^abc12");
  });

  it("a heading is linked by its text", async () => {
    const e = editor("# Plan\n\nbody", 3);
    expect((await copyBlockLink(e.view, 3, "N", vi.fn(async () => {})))?.link).toBe("[[N/Plan]]");
  });

  it("hands the link back when the clipboard refuses, still writing nothing", async () => {
    const e = editor("hello world", 2);
    const result = await copyBlockLink(e.view, 2, "N", async () => { throw new DOMException("denied", "NotAllowedError"); });
    expect(result).toEqual({ link: "[[N/hello world]]", copied: false });
    expect(e.text()).toBe("hello world");
  });

  it("is null, writing nothing, where there is no paragraph", async () => {
    const e = editor("```\nx\n```", 5);
    expect(await copyBlockLink(e.view, 5, "N", vi.fn())).toBeNull();
    expect(e.text()).toBe("```\nx\n```");
  });
});

describe("starting a link", () => {
  it("types [[ at the caret, which opens the note popup", () => {
    const e = editor("see ", 4);
    startWikilink(e.view);
    expect(e.text()).toBe("see [[");
    expect(e.view.state.selection.main.head).toBe(6);
    const line = e.view.state.doc.lineAt(6);
    expect(detectPopupTrigger(e.view.state.doc.sliceString(line.from, 6))).toMatchObject({ type: "wikilink", query: "" });
  });
});

describe("child notes: what the caret is on", () => {
  const nodes = [
    { id: "host", title: "Host", slug: "host", space_id: "s1", parent_id: null },
    { id: "kid", title: "Kid", slug: "kid", space_id: "s1", parent_id: "host" },
    { id: "far", title: "Far", slug: "far", space_id: "s1", parent_id: null },
  ] as never[];

  it("a paragraph, list item or heading can move; a quote, code or a blank line cannot", () => {
    const doc = "para\n\n- item\n\n## Head\n\n> quote\n\n```\ncode\n```\n";
    const e = editor(doc);
    const at = (needle: string) => doc.indexOf(needle) + 1;
    expect(["para", "item", "Head"].map((n) => canMoveToChild(e.view, at(n)))).toEqual([true, true, true]);
    expect(["quote", "code"].map((n) => canMoveToChild(e.view, at(n)))).toEqual([false, false]);
  });

  it("a line that is only ![[child]] names the child of this note, nothing else", () => {
    const doc = "![[Kid]]\n\n![[Far]]\n\n![[Kid#^x]]\n\n![[Kid#Part]]\n\ntext ![[Kid]]\n\n![[Kid|label]]\n";
    const e = editor(doc);
    const at = (line: number) => e.view.state.doc.line(line).from;
    expect(childEmbedAt(e.view, at(1), "host", nodes)?.id).toBe("kid");
    expect(childEmbedAt(e.view, at(3), "host", nodes)).toBeNull(); // a note that is not a child
    expect(childEmbedAt(e.view, at(5), "host", nodes)).toBeNull(); // one block of it
    expect(childEmbedAt(e.view, at(7), "host", nodes)).toBeNull(); // one section of it
    expect(childEmbedAt(e.view, at(9), "host", nodes)).toBeNull(); // inside a sentence
    expect(childEmbedAt(e.view, at(11), "host", nodes)?.id).toBe("kid");
    expect(childEmbedAt(e.view, at(1), "other-host", nodes)).toBeNull();
  });
});

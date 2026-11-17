// @vitest-environment jsdom
// 段落引用的安全網: 被引用次數（編輯器的數字、刪除提示）、已刪除的救回、
// 複製的段落連結貼上時才綁定到那一段 (lib/blockSafety).

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ContentNode } from "../lib/api";


vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite: vi.fn() }));

const { reads, noteWriter, blockLinkWriter } = await import("../lib/data");
const { editorBlocks } = await import("../lib/editorBlocks");
const { editorAnchors, setEditorAnchors } = await import("../lib/editorAnchors");
const { replaceAllAnchors } = await import("../lib/blockAnchorStore");
const { editorCitations, setCitations, removedCitedCounts } = await import("../lib/blockSafety");
const { groupCitations, citationCount } = await import("../lib/blockSafety");
const { deletedBlockFrom, withBlockRestored, findDeletedBlock } = await import("../lib/blockSafety");
const { pasteBlockLink } = await import("../lib/blockSafety");
const { recentBlocksStore } = await import("../lib/recentBlocksStore");
const { mountEmbed } = await import("../lib/embedDom");
const { resolveEmbed } = await import("../lib/embeds");
const { resetDrawingCache } = await import("../lib/embedSources");
const { resetBlockHomeCache } = await import("../lib/blockHome");
const { getAppState, resetAppState } = await import("../lib/appStore");
const { default: BlockCitationsMenu } = await import("../components/BlockCitationsMenu");

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const row = (block_ref: string, source_title: string, uses = 1) => ({ block_ref, source_id: `id-${source_title}`, source_title, uses });
const toasts = () => getAppState().toasts;

beforeEach(() => { resetAppState(); recentBlocksStore.save([]); });
afterEach(() => { vi.restoreAllMocks(); resetDrawingCache(); resetBlockHomeCache(); replaceAllAnchors([]); });

describe("citation rows", () => {
  it("group by paragraph and count every citing place", () => {
    const grouped = groupCitations([row("a", "One"), row("a", "Two", 2), row("b", "One")]);
    expect(citationCount(grouped.get("a"))).toBe(3);
    expect(citationCount(grouped.get("b"))).toBe(1);
    expect(citationCount(grouped.get("none"))).toBe(0);
  });
});

describe("the editor's number and the delete notice", () => {
  // The paragraphs' identity is an anchor (the text has no id): c1 is the first paragraph, p2 the second.
  const doc = "cited paragraph\n\nplain paragraph\n";
  const anchors = [{ id: "c1", from: 0, to: 15 }, { id: "p2", from: doc.indexOf("plain"), to: doc.indexOf("plain") + 15 }];
  function editor(rows = [row("c1", "One"), row("c1", "Two")], text = doc) {
    const open = vi.fn();
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: [history(), editorBlocks, editorAnchors(() => "n1"), editorCitations(open)] }),
      parent: document.body,
    });
    view.dispatch({ effects: [setEditorAnchors.of(anchors), setCitations.of(rows)] });
    return { view, open };
  }

  it("shows the count only on the cited paragraph, and a tap lists them", () => {
    const { view, open } = editor();
    const badges = view.dom.querySelectorAll<HTMLElement>(".cm-block-cited");
    expect([...badges].map((b) => b.textContent)).toEqual(["2"]);
    badges[0]!.click();
    expect(open).toHaveBeenCalledWith("c1", badges[0]);
    view.destroy();
  });

  it("deleting the cited paragraph says how many places cite it, with Undo that brings it back", () => {
    const { view } = editor();
    const from = 0, to = "cited paragraph".length;
    view.dispatch({ changes: { from, to }, userEvent: "delete.selection" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.message).toBe("This paragraph has 2 citations");
    toasts()[0]!.action!.onClick();
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("an uncited paragraph deletes silently, and so does typing in the cited one", () => {
    const { view } = editor();
    const at = doc.indexOf("plain");
    view.dispatch({ changes: { from: at, to: at + "plain paragraph".length }, userEvent: "delete.selection" });
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    expect(toasts()).toHaveLength(0);
    view.destroy();
  });

  it("undo of the delete itself raises no new notice, and the Undo button refuses after later edits", () => {
    const { view } = editor();
    view.dispatch({ changes: { from: 0, to: "cited paragraph".length }, userEvent: "delete.selection" });
    const action = toasts()[0]!.action!;
    view.dispatch({ changes: { from: 0, insert: "later " }, userEvent: "input.type" });
    action.onClick();
    expect(toasts().at(-1)!.message).toMatch(/edited since/);
    expect(view.state.doc.toString()).toContain("later");
    undo(view); // the editor's own undo
    expect(toasts().filter((t) => t.message.includes("citation"))).toHaveLength(1);
    view.destroy();
  });

  it("removedCitedCounts counts a paragraph only once all its text is gone", () => {
    const { view } = editor();
    const seen: number[][] = [];
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((u) => { seen.push(removedCitedCounts(u)); })) });
    view.dispatch({ changes: { from: 0, to: 6 }, userEvent: "delete.selection" }); // part of the words
    expect(seen.flat()).toEqual([]);
    view.dispatch({ changes: { from: 0, to: 9 }, userEvent: "delete.selection" }); // the rest
    expect(seen.flat()).toEqual([2]);
    view.destroy();
  });

  it("a cut and paste inside the note moves the number with the paragraph, with no notice", () => {
    const { view } = editor();
    const cut = new Event("cut") as ClipboardEvent;
    view.dispatch({ selection: { anchor: 0, head: 15 } });
    view.contentDOM.dispatchEvent(cut);
    view.dispatch({ changes: { from: 0, to: 15 }, userEvent: "delete.cut" });
    expect(toasts()).toHaveLength(1); // the cut itself is a deletion; the paste brings it back
    const at = view.state.doc.length;
    view.dispatch({ changes: { from: at, insert: "cited paragraph" }, userEvent: "input.paste" });
    expect([...view.dom.querySelectorAll(".cm-block-cited")].map((b) => b.textContent)).toEqual(["2"]);
    view.destroy();
  });
});

describe("the citing-notes list", () => {
  it("lists each note, and picking one hands it back", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const onPick = vi.fn();
    const { getByText } = render(<BlockCitationsMenu rows={[row("c1", "One"), row("c1", "Two", 2)]} anchor={anchor} onPick={onPick} onClose={() => {}} />);
    expect(getByText(/Cited here 3 times/)).toBeTruthy();
    fireEvent.click(getByText(/Two/));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ source_title: "Two" }));
  });
});

describe("a deleted paragraph comes back from the note's history", () => {
  const now = "# Title\n\nfirst\n\nlast\n";
  const older = "# Title\n\nfirst\n\nthe lost words\n\nlast\n";
  // The anchors the server holds for note a1: "first" is still valid; gone1 (the lost words) was deleted, and remembers what it said.
  const held = (noteId = "a1") => replaceAllAnchors([
    { anchor_id: "a1", note_id: noteId, from: 9, to: 14, status: "valid", candidate_from: null, candidate_to: null, quote: "first" },
    { anchor_id: "gone1", note_id: noteId, from: 0, to: 0, status: "lost", candidate_from: null, candidate_to: null, quote: "the lost words" }, // a lost anchor stands nowhere
  ]);

  it("takes the newest version that had its words and puts it after the paragraph that preceded it", () => {
    const block = deletedBlockFrom([{ markdown: now }, { markdown: older }, { markdown: "very old the lost words" }], "the lost words", now, [{ id: "a1", from: 9, to: 14 }])!;
    expect(block).toEqual({ text: "the lost words", after: "a1", before: null });
    expect(withBlockRestored(now, block, [{ id: "a1", from: 9, to: 14 }])).toBe(older);
  });

  describe("where it goes is read from the history version (a lost anchor has no position to read)", () => {
    it("after the nearest paragraph before it that the note still has, found by its words, wherever it stands now", () => {
      const grown = "# Title\n\na new paragraph above\n\nfirst\n\nlast\n";
      const at = grown.indexOf("first");
      const anchors = [{ id: "a1", from: at, to: at + 5 }];
      const block = deletedBlockFrom([{ markdown: older }], "the lost words", grown, anchors)!;
      expect(block).toMatchObject({ after: "a1", before: null });
      expect(withBlockRestored(grown, block, anchors)).toBe("# Title\n\na new paragraph above\n\nfirst\n\nthe lost words\n\nlast\n");
    });
    it("every paragraph before it was rewritten or is gone: before the nearest one after it that the note still has", () => {
      const current = "# Title\n\nfirst, rewritten\n\nlast\n";
      const at = current.indexOf("last");
      const anchors = [{ id: "z1", from: at, to: at + 4 }];
      const block = deletedBlockFrom([{ markdown: older }], "the lost words", current, anchors)!;
      expect(block).toMatchObject({ after: null, before: "z1" });
      expect(withBlockRestored(current, block, anchors)).toBe("# Title\n\nfirst, rewritten\n\nthe lost words\n\nlast\n");
    });
    // The anchors are the note's paragraphs as held now; `at` finds one by its words in the text.
    const anchorsFor = (current: string, ...words: string[]) => words.map((w, i) => ({ id: `w${i}`, from: current.indexOf(w), to: current.indexOf(w) + w.length }));
    const goesAfter = (older: string, current: string, ...words: string[]) => deletedBlockFrom([{ markdown: older }], "the lost words", current, anchorsFor(current, ...words))!;

    it("tags and ids at the end of a paragraph do not matter, on either side", () => {
      expect(goesAfter("first {考點}\n\nthe lost words\n\nlast\n", "first\n\nlast\n", "first")).toMatchObject({ after: "w0" }); // the old text had a tag, the note's paragraph has none
      expect(goesAfter("first\n\nthe lost words\n\nlast\n", "first {考點}\n\nlast\n", "first {考點}")).toMatchObject({ after: "w0" }); // the note's paragraph has a tag, the old text had none
      expect(goesAfter("first ^ffb6f7\n\nthe lost words\n\nlast\n", "first\n\nlast\n", "first")).toMatchObject({ after: "w0" }); // a trailing ^id mark
      expect(goesAfter("first\n\nthe lost words\n\nlast {考點}\n", "other\n\nlast\n", "last")).toMatchObject({ before: "w0" }); // forward, tag in the old text
    });
    it("headings and list items, with or without their marker in the paragraph's range", () => {
      expect(goesAfter("# Head\n\nthe lost words\n\nlast\n", "# Head\n\nlast\n", "# Head")).toMatchObject({ after: "w0" });
      expect(goesAfter("# Head\n\nthe lost words\n\nlast\n", "# Head\n\nlast\n", "Head")).toMatchObject({ after: "w0" });
      // the last item of a list stands before it; the first item of a list stands after it
      expect(goesAfter("- a\n- b\n\nthe lost words\n", "- a\n- b\n", "- b")).toMatchObject({ after: "w0" });
      expect(goesAfter("- a\n- b\n\nthe lost words\n", "- a\n- b\n", "b")).toMatchObject({ after: "w0" });
      expect(goesAfter("the lost words\n\n- a\n- b\n", "- a\n- b\n", "a")).toMatchObject({ before: "w0" });
      expect(goesAfter("the lost words\n\n1. a\n2. b\n", "1. a\n2. b\n", "1. a")).toMatchObject({ before: "w0" });
    });
    it("line ends written \\r\\n in the old text or in the note", () => {
      expect(goesAfter("first\r\n\r\nthe lost words\r\n\r\nlast\r\n", "first\n\nlast\n", "first")).toMatchObject({ after: "w0" });
      expect(goesAfter("first\n\nthe lost words\n\nlast\n", "first\r\n\r\nlast\r\n", "first")).toMatchObject({ after: "w0" });
    });
    it("two paragraphs with the same words: the one in the same order among its twins as in the old text", () => {
      const current = "dup\n\nmiddle\n\ndup\n\nend\n";
      const both = (older: string) => deletedBlockFrom([{ markdown: older }], "the lost words", current, [{ id: "d1", from: 0, to: 3 }, { id: "d2", from: current.indexOf("dup", 4), to: current.indexOf("dup", 4) + 3 }])!;
      expect(both("dup\n\nmiddle\n\ndup\n\nthe lost words\n\nend\n")).toMatchObject({ after: "d2" }); // it followed the second
      expect(both("dup\n\nthe lost words\n\nmiddle\n\ndup\n\nend\n")).toMatchObject({ after: "d1" }); // it followed the first
    });
    it("nothing on either side is left: the end of the note", () => {
      const current = "# Title\n\nfirst, rewritten\n\nlast, rewritten\n";
      const anchors = [{ id: "a1", from: 9, to: 26 }, { id: "z1", from: 28, to: 44 }];
      const block = deletedBlockFrom([{ markdown: older }], "the lost words", current, anchors)!;
      expect(block).toMatchObject({ after: null, before: null });
      expect(withBlockRestored(current, block, anchors)).toBe(`${current.trimEnd()}\n\nthe lost words\n`);
    });
  });

  it("restores the whole paragraph even when the anchor only remembers its first words", () => {
    const long = "the lost words and then a very long rest of the paragraph";
    const block = deletedBlockFrom([{ markdown: `${now}\n${long}\n` }], "the lost words", now)!;
    expect(block.text).toBe(long);
  });

  it("appends at the end when nothing before it survives, and does nothing when it is already back", () => {
    const block = deletedBlockFrom([{ markdown: "gone words\n" }], "gone words", "other\n")!;
    expect(block.after).toBeNull();
    expect(withBlockRestored("other\n", block)).toBe("other\n\ngone words\n");
    expect(withBlockRestored("gone words\n", block)).toBe("gone words\n");
    expect(deletedBlockFrom([{ markdown: older }], "the lost words", older)).toBeNull();
  });

  it("is null with no version that had it, no words to look for, and when the history cannot be read", async () => {
    expect(deletedBlockFrom([{ markdown: now }], "the lost words", now)).toBeNull();
    expect(deletedBlockFrom([{ markdown: older }], "  ", now)).toBeNull();
    held();
    vi.spyOn(reads.notes, "rawVersions").mockRejectedValue(new Error("offline"));
    expect(await findDeletedBlock("a1", "gone1", now)).toBeNull();
  });

  it("an anchor that is not lost (or unknown) has nothing to restore", async () => {
    held();
    vi.spyOn(reads.notes, "rawVersions").mockResolvedValue([{ markdown: older }] as never);
    expect(await findDeletedBlock("a1", "a1", now)).toBeNull();
    expect(await findDeletedBlock("a1", "nope", now)).toBeNull();
    expect(await findDeletedBlock("a1", "gone1", now)).toEqual({ text: "the lost words", after: "a1", before: null });
  });

  const alpha = { id: "a1", title: "Alpha", slug: "alpha", markdown: now, node_type: "content" } as unknown as ContentNode;
  const mount = (canRestore: boolean) => {
    const el = document.createElement("div");
    document.body.append(el);
    mountEmbed(el, resolveEmbed("Alpha#^gone1", null, [alpha]), {
      nodes: [alpha], canRestoreBlock: canRestore ? () => true : undefined,
    });
    return el;
  };

  it("an embed shows 「已刪除」, and 「救回」 only where the history has it and the reader may edit", async () => {
    held();
    vi.spyOn(reads.notes, "blockHome").mockResolvedValue(null);
    const versions = vi.spyOn(reads.notes, "rawVersions").mockResolvedValue([{ markdown: older }] as never);
    const readOnly = mount(false);
    await waitFor(() => expect(readOnly.querySelector(".md-embed-notice")?.textContent).toBe("This paragraph was deleted"));
    expect(readOnly.querySelector(".md-embed-restore")).toBeNull();
    expect(versions).not.toHaveBeenCalled();

    const editable = mount(true);
    await waitFor(() => expect(editable.querySelector(".md-embed-restore")).not.toBeNull());
    expect(editable.querySelector(".md-embed-notice")?.textContent).toBe("This paragraph was deleted · Restore");
  });

  it("without any version holding it, an editor sees only 「已刪除」", async () => {
    held();
    vi.spyOn(reads.notes, "blockHome").mockResolvedValue(null);
    vi.spyOn(reads.notes, "rawVersions").mockResolvedValue([{ markdown: now }] as never);
    const editable = mount(true);
    await waitFor(() => expect(editable.querySelector(".md-embed-notice")?.textContent).toBe("This paragraph was deleted"));
    await act(async () => { await Promise.resolve(); });
    expect(editable.querySelector(".md-embed-restore")).toBeNull();
  });

  it("pressing 「救回」 writes the paragraph back to the note as an ordinary edit", async () => {
    held();
    vi.spyOn(reads.notes, "blockHome").mockResolvedValue(null);
    vi.spyOn(reads.notes, "rawVersions").mockResolvedValue([{ markdown: older }] as never);
    const patch = vi.spyOn(noteWriter, "patch").mockResolvedValue(undefined as never);
    const { setAppState } = await import("../lib/appStore");
    setAppState((s) => ({ data: { ...s.data, nodes: [alpha] } }));
    const editable = mount(true);
    await waitFor(() => expect(editable.querySelector(".md-embed-restore")).not.toBeNull());
    fireEvent.click(editable.querySelector(".md-embed-restore")!);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("a1", { markdown: older }, { baseMarkdown: now });
    await waitFor(() => expect(toasts().some((t) => t.message === "Restored the paragraph" && t.action?.label === "Undo")).toBe(true));
  });
});

describe("a copied part link is bound to its paragraph when pasted into Onden", () => {
  const view = (doc: string) => new EditorView({ state: EditorState.create({ doc, extensions: [history()] }), parent: document.body });
  const copied = async (doc: string, caret: number, title = "Source") => {
    const { copyBlockLink, bindEditorNote } = await import("../lib/editorParagraphActions");
    const v = view(doc);
    bindEditorNote(v, () => "n1");
    const write = vi.fn(async (_t: string) => {});
    const result = await copyBlockLink(v, caret, title, write);
    return { v, write, result };
  };
  const ctx = (noteId: string | undefined, on: EditorView | null = null) => ({ noteId, stillOn: () => on });

  it("copying writes nothing into the note it is copied from and puts the link, by its words, on the clipboard", async () => {
    const { v, write, result } = await copied("alpha\n\nsecond words here\n", 10);
    expect(v.state.doc.toString()).toBe("alpha\n\nsecond words here\n");
    expect(write).toHaveBeenCalledWith("[[Source/second words here]]");
    expect(result).toEqual({ link: "[[Source/second words here]]", copied: true });
    v.destroy();
  });

  it("a heading is copied too, a quote is not", async () => {
    const heading = await copied("# Plan\n\nbody\n", 3);
    expect(heading.result?.link).toBe("[[Source/Plan]]");
    heading.v.destroy();
    const quote = await copied("> quoted", 3);
    expect(quote.result).toBeNull();
    quote.v.destroy();
  });

  it("pasting it into a note puts the text in as one edit and asks the server to bind it", async () => {
    const { v: source } = await copied("alpha\n\nsecond words here\n", 10);
    const bind = vi.spyOn(blockLinkWriter, "bind").mockResolvedValue({ anchorId: "x1", link: "Source/second words here", linkText: "second words here" });
    const v = view("elsewhere ");
    v.dispatch({ selection: { anchor: 10 } });
    expect(pasteBlockLink(v, "[[Source/second words here]]", ctx("n2", v))).toBe(true);
    expect(v.state.doc.toString()).toBe("elsewhere [[Source/second words here]]");
    expect(bind).toHaveBeenCalledWith("n2", "n1", { at: 7, seenText: "second words here", suggestedText: "second words here" });
    undo(v);
    expect(v.state.doc.toString()).toBe("elsewhere ");
    v.destroy(); source.destroy();
  });

  it("when the server settled on other words the pasted text follows them", async () => {
    const { v: source } = await copied("alpha\n\nsecond words here\n", 10);
    vi.spyOn(blockLinkWriter, "bind").mockResolvedValue({ anchorId: "x1", link: "Source/second words here 2", linkText: "second words here 2" });
    const v = view("");
    pasteBlockLink(v, "[[Source/second words here]]", ctx("n2", v));
    await waitFor(() => expect(v.state.doc.toString()).toBe("[[Source/second words here 2]]"));
    v.destroy(); source.destroy();
  });

  it("other text, another link or a note-less editor is not handled", async () => {
    const { v: source } = await copied("alpha\n\nsecond words here\n", 10);
    const bind = vi.spyOn(blockLinkWriter, "bind").mockResolvedValue(null);
    expect(pasteBlockLink(view(""), "just text", ctx("n2"))).toBe(false);
    expect(pasteBlockLink(view(""), "[[Source/another paragraph]]", ctx("n2"))).toBe(false);
    expect(pasteBlockLink(view(""), "[[Source/second words here]]", ctx(undefined))).toBe(false);
    expect(bind).not.toHaveBeenCalled();
    source.destroy();
  });
});

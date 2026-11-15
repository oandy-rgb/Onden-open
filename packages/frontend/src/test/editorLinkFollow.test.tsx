// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  anchorPosition, chipLink, editorLinkFollow, followLink, followsOnTap, linkAt, linkAroundCaret,
  parseWikilinkBody, type EditorLink, type LinkChip, type LinkFollowEnv, type TapContext,
} from "../lib/editorLinkFollow";
import { editorAnchorsField, setEditorAnchors } from "../lib/editorAnchors";
import EditorLinkChip from "../components/EditorLinkChip";

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

function stateOf(doc: string, anchor = 0, anchors: Array<{ id: string; from: number; to: number }> = []) {
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage }), editorAnchorsField] }).update({ effects: setEditorAnchors.of(anchors) }).state;
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}
const labelOf = (link: EditorLink | null) => (link?.kind === "wikilink" ? link.label : undefined);

/** The link under the character at the first occurrence of `at` in `doc`. */
function linkOn(doc: string, at: string) {
  return linkAt(stateOf(doc), doc.indexOf(at));
}

describe("link detection at a position", () => {
  it("a wikilink with an alias names the note, not the alias", () => {
    expect(linkOn("see [[Project Plan|the plan]] now", "plan]]")).toMatchObject({ kind: "wikilink", label: "Project Plan" });
  });

  it("a heading anchor", () => {
    expect(linkOn("[[Project Plan#Goals]]", "Goals")).toMatchObject({ kind: "wikilink", label: "Project Plan", heading: "Goals" });
  });

  it("a ^block anchor", () => {
    const link = linkOn("[[Project Plan#^abc-12]]", "abc");
    expect(link).toMatchObject({ kind: "wikilink", label: "Project Plan", blockId: "abc-12" });
    expect(link).not.toHaveProperty("heading");
  });

  it("a same-note anchor has an empty label", () => {
    expect(linkOn("[[#Goals]]", "Goals")).toMatchObject({ label: "", heading: "Goals" });
    expect(linkOn("[[#^b1]]", "b1")).toMatchObject({ label: "", blockId: "b1" });
  });

  it("an https URL, bare or in [text](url)", () => {
    expect(linkOn("go https://example.com/a now", "example")).toMatchObject({ kind: "url", url: "https://example.com/a" });
    expect(linkOn("go [site](https://example.com/b) now", "site")).toMatchObject({ kind: "url", url: "https://example.com/b" });
  });

  it("a javascript: destination is not a link", () => {
    expect(linkOn("[x](javascript:alert(1))", "x")).toBeNull();
  });

  it("plain text, [text] and an embed are not links", () => {
    expect(linkOn("plain words", "words")).toBeNull();
    expect(linkOn("a [lone] bracket", "lone")).toBeNull();
    expect(linkOn("![[drawing]]", "drawing")).toBeNull();
    expect(linkOn("![alt](https://example.com/i.png)", "alt")).toBeNull();
  });

  it("inside a code span or a fence is not a link", () => {
    expect(linkOn("use `[[Note]]` here", "Note")).toBeNull();
    expect(linkOn("`https://example.com`", "example")).toBeNull();
    expect(linkOn("```\n[[Note]]\nhttps://example.com\n```", "Note")).toBeNull();
    expect(linkOn("```\n[[Note]]\nhttps://example.com\n```", "example")).toBeNull();
  });

  it("covers the link's characters, not the text after it", () => {
    const doc = "a [[Note]] b";
    const state = stateOf(doc);
    expect(labelOf(linkAt(state, 2))).toBe("Note");
    expect(labelOf(linkAt(state, 9))).toBe("Note");
    expect(linkAt(state, 10)).toBeNull();
    expect(linkAt(state, 1)).toBeNull();
  });

  it("the caret is inside strictly between a link's ends", () => {
    const state = stateOf("a [[Note]] b");
    expect(linkAroundCaret(state, 2)).toBeNull();
    expect(labelOf(linkAroundCaret(state, 3))).toBe("Note");
    expect(labelOf(linkAroundCaret(state, 9))).toBe("Note");
    expect(linkAroundCaret(state, 10)).toBeNull();
  });

  it("parseWikilinkBody drops the alias and splits the anchor", () => {
    expect(parseWikilinkBody("A|b#c")).toEqual({ label: "A" });
    expect(parseWikilinkBody("A#H  two")).toEqual({ label: "A", heading: "H two" });
    expect(parseWikilinkBody("A#^")).toEqual({ label: "A" });
  });
});

describe("whether a press follows", () => {
  const base: TapContext = { pointer: "mouse", focused: false, readOnly: false, modifier: false, composing: false };
  const follows = (over: Partial<TapContext>) => followsOnTap({ ...base, ...over });

  it("touch: follows when the editor is not focused, places the caret when it is", () => {
    expect(follows({ pointer: "touch", focused: false })).toBe(true);
    expect(follows({ pointer: "touch", focused: true })).toBe(false);
    expect(follows({ pointer: "pen", focused: false })).toBe(true);
    expect(follows({ pointer: "pen", focused: true })).toBe(false);
  });

  it("mouse: only with Ctrl/Cmd, focused or not", () => {
    expect(follows({ modifier: false })).toBe(false);
    expect(follows({ modifier: false, focused: true })).toBe(false);
    expect(follows({ modifier: true })).toBe(true);
    expect(follows({ modifier: true, focused: true })).toBe(true);
  });

  it("read-only: a plain tap or click follows", () => {
    expect(follows({ readOnly: true })).toBe(true);
    expect(follows({ readOnly: true, pointer: "touch", focused: true })).toBe(true);
  });

  it("never while composing", () => {
    expect(follows({ composing: true, modifier: true })).toBe(false);
    expect(follows({ composing: true, pointer: "touch" })).toBe(false);
    expect(follows({ composing: true, readOnly: true })).toBe(false);
  });
});

describe("the chip shows only while the caret is in a link", () => {
  const doc = "a [[Note]] b https://example.com/x c";
  const ctx = { touch: true, focused: true, composing: false, readOnly: false };

  it("caret inside a wikilink or a URL", () => {
    expect(chipLink(stateOf(doc, 5), ctx)?.kind).toBe("wikilink");
    expect(chipLink(stateOf(doc, doc.indexOf("example")), ctx)?.kind).toBe("url");
  });

  it("not outside a link, at its edges, or with a selection", () => {
    expect(chipLink(stateOf(doc, 0), ctx)).toBeNull();
    expect(chipLink(stateOf(doc, 2), ctx)).toBeNull();
    expect(chipLink(stateOf(doc, 10), ctx)).toBeNull();
    const selecting = EditorState.create({ doc, selection: { anchor: 4, head: 7 }, extensions: [markdown({ base: markdownLanguage })] });
    expect(chipLink(selecting, ctx)).toBeNull();
  });

  it("not unless touch, focused, editable and not composing", () => {
    const state = stateOf(doc, 5);
    expect(chipLink(state, { ...ctx, touch: false })).toBeNull();
    expect(chipLink(state, { ...ctx, focused: false })).toBeNull();
    expect(chipLink(state, { ...ctx, readOnly: true })).toBeNull();
    expect(chipLink(state, { ...ctx, composing: true })).toBeNull();
  });

  it("the extension reports the chip as the caret enters and leaves a link", async () => {
    const seen: Array<LinkChip | null> = [];
    const env = { resolveNote: () => null, selfId: () => null, openWikilink: () => {} } as LinkFollowEnv;
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc, selection: { anchor: 0 },
        extensions: [markdown({ base: markdownLanguage }), editorLinkFollow({ env, onChip: (c) => seen.push(c) })],
      }),
    });
    // jsdom has no layout: give the measure a caret rectangle, and a focused touch editor.
    view.coordsAtPos = () => ({ left: 40, right: 41, top: 100, bottom: 120 });
    Object.defineProperty(view, "hasFocus", { get: () => true });
    const touchDown = new Event("pointerdown") as Event & { pointerType: string; button: number; isPrimary: boolean };
    // A secondary button only records the pointer kind (no hit test: jsdom has no layout).
    Object.assign(touchDown, { pointerType: "touch", button: 2, isPrimary: true });
    view.contentDOM.dispatchEvent(touchDown);

    view.dispatch({ selection: { anchor: 5 } });
    await new Promise((resolve) => requestAnimationFrame(resolve)); // the requested measure runs
    expect(seen.at(-1)?.link).toMatchObject({ kind: "wikilink", label: "Note" });
    expect(seen.at(-1)?.caret).toMatchObject({ top: 100, bottom: 120 });

    view.dispatch({ selection: { anchor: 0 } });
    expect(seen.at(-1)).toBeNull();
    view.destroy();
    parent.remove();
  });

  it("the chip button opens the link and does not take focus", () => {
    const chip: LinkChip = { link: linkOn("[[Note]]", "Note")!, caret: { left: 50, top: 100, bottom: 120 } };
    const onFollow = vi.fn();
    render(<EditorLinkChip chip={chip} wrap={null} onFollow={onFollow} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("Open ↗");
    const down = fireEvent.mouseDown(button);
    expect(down).toBe(false); // preventDefault: the editor keeps focus and the keyboard stays
    fireEvent.click(button);
    expect(onFollow).toHaveBeenCalledOnce();
  });
});

describe("following", () => {
  function setup(doc: string, selfId: string | null = "self", anchors: Array<{ id: string; from: number; to: number }> = []) {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), editorAnchorsField] }),
    });
    view.dispatch({ effects: setEditorAnchors.of(anchors) });
    const env: LinkFollowEnv = {
      resolveNote: (label) => (label === "Other" ? { id: "other" } : label === "Self" ? { id: "self" } : null),
      selfId: () => selfId,
      openWikilink: vi.fn(),
      openUrl: vi.fn(),
    };
    return { view, env };
  }
  const first = (view: EditorView) => linkAt(view.state, view.state.doc.toString().indexOf("[[") + 2) ?? linkAt(view.state, 0)!;

  it("a wikilink opens its note by id; an unresolved one passes null (Preview creates it)", () => {
    const a = setup("[[Other]]");
    followLink(a.view, first(a.view), a.env);
    expect(a.env.openWikilink).toHaveBeenCalledWith("Other", "other");
    const b = setup("[[Nowhere]]");
    followLink(b.view, first(b.view), b.env);
    expect(b.env.openWikilink).toHaveBeenCalledWith("Nowhere", null);
  });

  it("a URL opens through openUrl", () => {
    const { view, env } = setup("https://example.com/a");
    followLink(view, linkAt(view.state, 3)!, env);
    expect(env.openUrl).toHaveBeenCalledWith("https://example.com/a");
    expect(env.openWikilink).not.toHaveBeenCalled();
  });

  it("a same-note heading / old ^block target (the anchor's id) scrolls the editor instead of opening", () => {
    const doc = "[[#Goals]] [[Self#^b2]]\n\n# Goals\n\nsome text\n";
    const { view, env } = setup(doc, "self", [{ id: "b2", from: doc.indexOf("some text"), to: doc.length - 1 }]);
    view.scrollDOM.scrollTop = 0;
    expect(followLink(view, linkAt(view.state, 3)!, env)).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.indexOf("# Goals"));
    expect(followLink(view, linkAt(view.state, doc.indexOf("Self"))!, env)).toBe(true);
    expect(view.state.selection.main.head).toBe(doc.indexOf("some text"));
    expect(env.openWikilink).not.toHaveBeenCalled();
  });

  it("a missing same-note anchor does nothing; an anchor in another note opens that note", () => {
    const { view, env } = setup("[[#Nope]] [[Other#Goals]]");
    expect(followLink(view, linkAt(view.state, 3)!, env)).toBe(false);
    followLink(view, linkAt(view.state, 14)!, env);
    expect(env.openWikilink).toHaveBeenCalledWith("Other", "other");
  });

  it("anchorPosition finds ATX and setext headings and anchored paragraphs, and ignores a prefix of an id", () => {
    const doc = "Title\n=====\n\n## A  b ##\n\npara one\npara two\n";
    const state = stateOf(doc, 0, [{ id: "x1", from: doc.indexOf("para one"), to: doc.indexOf("para one") + 8 }, { id: "x", from: doc.indexOf("para two"), to: doc.length - 1 }]);
    expect(anchorPosition(state, { heading: "title" })).toBe(0);
    expect(anchorPosition(state, { heading: "a b" })).toBe(state.doc.toString().indexOf("## A"));
    expect(anchorPosition(state, { blockId: "x" })).toBe(state.doc.toString().indexOf("para two"));
    expect(anchorPosition(state, { blockId: "x2" })).toBeNull();
  });
});

describe("the press gestures", () => {
  function press(view: EditorView, type: "pointerdown" | "pointerup" | "mousedown", init: Record<string, unknown>) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries({ button: 0, isPrimary: true, pointerId: 1, clientX: 5, clientY: 5, timeStamp: 0, ...init })) {
      Object.defineProperty(e, k, { value: v });
    }
    view.contentDOM.dispatchEvent(e);
    return e;
  }

  function mount(opts: { focused: boolean; readOnly?: boolean }) {
    const openWikilink = vi.fn();
    const env = { resolveNote: () => null, selfId: () => null, openWikilink, openUrl: vi.fn() } as LinkFollowEnv;
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({
        doc: "a [[Note]] b",
        extensions: [markdown({ base: markdownLanguage }), editorLinkFollow({ env, onChip: () => {} }), EditorState.readOnly.of(!!opts.readOnly)],
      }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    // jsdom has no layout: the pointer is over the 'N' of Note (pos 4).
    view.posAtCoords = () => 4;
    view.coordsAtPos = () => ({ left: 0, right: 1, top: 0, bottom: 1 });
    Object.defineProperty(view, "hasFocus", { get: () => opts.focused });
    return { view, openWikilink };
  }

  it("a touch tap on a link while reading follows it, and the caret and keyboard are left alone", () => {
    const { view, openWikilink } = mount({ focused: false });
    press(view, "pointerdown", { pointerType: "touch" });
    press(view, "pointerup", { pointerType: "touch", timeStamp: 80 });
    expect(openWikilink).toHaveBeenCalledWith("Note", null);
    press(view, "mousedown", {});
    expect(view.state.selection.main.head).toBe(0); // the editor never saw the press
  });

  it("a touch that moved (a scroll), or lasted (a long press), does not follow", () => {
    const { view, openWikilink } = mount({ focused: false });
    press(view, "pointerdown", { pointerType: "touch" });
    press(view, "pointerup", { pointerType: "touch", clientY: 60, timeStamp: 80 });
    press(view, "pointerdown", { pointerType: "touch" });
    press(view, "pointerup", { pointerType: "touch", timeStamp: 900 });
    expect(openWikilink).not.toHaveBeenCalled();
    press(view, "mousedown", {});
    expect(view.state.selection.main.head).not.toBe(0); // the press reached the editor: caret placed
  });

  it("a touch tap while writing leaves the caret to the editor", () => {
    const { view, openWikilink } = mount({ focused: true });
    press(view, "pointerdown", { pointerType: "touch" });
    press(view, "pointerup", { pointerType: "touch", timeStamp: 80 });
    expect(openWikilink).not.toHaveBeenCalled();
    press(view, "mousedown", {});
    expect(view.state.selection.main.head).not.toBe(0); // the press reached the editor: caret placed
  });

  it("a mouse follows only with Ctrl or Cmd", () => {
    const { view, openWikilink } = mount({ focused: true });
    press(view, "pointerdown", { pointerType: "mouse" });
    press(view, "pointerup", { pointerType: "mouse", timeStamp: 50 });
    expect(openWikilink).not.toHaveBeenCalled();
    press(view, "pointerdown", { pointerType: "mouse", ctrlKey: true });
    press(view, "pointerup", { pointerType: "mouse", ctrlKey: true, timeStamp: 50 });
    press(view, "pointerdown", { pointerType: "mouse", metaKey: true });
    press(view, "pointerup", { pointerType: "mouse", metaKey: true, timeStamp: 50 });
    expect(openWikilink).toHaveBeenCalledTimes(2);
  });

  it("a read-only note follows on a plain click and shows the hand", () => {
    const { view, openWikilink } = mount({ focused: false, readOnly: true });
    press(view, "pointerdown", { pointerType: "mouse" });
    press(view, "pointerup", { pointerType: "mouse", timeStamp: 50 });
    expect(openWikilink).toHaveBeenCalledOnce();
    expect(view.dom.classList.contains("cm-link-follow")).toBe(true);
  });

  it("holding Ctrl/Cmd turns the pointer into a hand, releasing it restores", () => {
    const { view } = mount({ focused: true });
    expect(view.dom.classList.contains("cm-link-follow")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    expect(view.dom.classList.contains("cm-link-follow")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(view.dom.classList.contains("cm-link-follow")).toBe(false);
  });

  it("a press off any link does nothing", () => {
    const { view, openWikilink } = mount({ focused: false });
    view.posAtCoords = () => 0;
    press(view, "pointerdown", { pointerType: "touch" });
    press(view, "pointerup", { pointerType: "touch", timeStamp: 50 });
    expect(openWikilink).not.toHaveBeenCalled();
  });
});

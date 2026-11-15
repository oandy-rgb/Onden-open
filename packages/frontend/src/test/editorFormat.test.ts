import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { activeFormats, FORMAT_KEYS, formatKeyBindings, insertLink, prefixLines, setHeading, toggleHeading, toggleLinePrefix, toggleWrap } from "../lib/editorFormat";
import { reservedOwner } from "../lib/shortcuts";

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });
function editor(doc: string, anchor: number, head = anchor) {
  view = new EditorView({ state: EditorState.create({ doc, selection: { anchor, head } }) });
  return view;
}
const text = () => view!.state.doc.toString();

describe("editorFormat", () => {
  it("toggleWrap wraps, and unwraps from either side of the delimiters", () => {
    const v = editor("make this bold", 5, 9);
    toggleWrap(v, 5, 9, "**", "**");
    expect(text()).toBe("make **this** bold");
    // The selection now sits inside the delimiters: the same button unwraps.
    const { from, to } = v.state.selection.main;
    toggleWrap(v, from, to, "**", "**");
    expect(text()).toBe("make this bold");
    // Selecting the delimiters themselves unwraps too.
    const w = editor("a *b* c", 2, 5);
    toggleWrap(w, 2, 5, "*", "*");
    expect(view!.state.doc.toString()).toBe("a b c");
  });

  it("the editors' formatting keys toggle their mark and are reserved from shortcuts (D103)", () => {
    const v = editor("a **b** c", 4, 5);
    const bold = formatKeyBindings(toggleWrap).find((b) => b.key === "Mod-b")!;
    expect(bold.run!(v)).toBe(true);
    expect(text()).toBe("a b c");
    expect(FORMAT_KEYS.map((k) => k.key)).toEqual(["Mod-b", "Mod-i", "Mod-u"]);
    for (const chord of ["$mod+b", "$mod+i", "$mod+u"]) expect(reservedOwner(chord)).toBe("editor");
  });

  it("setHeading replaces existing heading marks on the caret's line", () => {
    editor("## Old\nbody", 3);
    setHeading(view!, 1);
    expect(text()).toBe("# Old\nbody");
  });

  it("prefixLines prefixes every selected line", () => {
    editor("one\ntwo\nthree", 1, 6);
    prefixLines(view!, "> ");
    expect(text()).toBe("> one\n> two\nthree");
  });

  it("toggleHeading clears the active level and sets any other", () => {
    editor("## Title\nbody", 4);
    toggleHeading(view!, 2);
    expect(text()).toBe("Title\nbody");
    toggleHeading(view!, 2);
    expect(text()).toBe("## Title\nbody");
    toggleHeading(view!, 3);
    expect(text()).toBe("### Title\nbody");
  });

  it("toggleLinePrefix removes a prefix every selected line has, else adds it", () => {
    editor("> one\n> two\nthree", 3, 8);
    toggleLinePrefix(view!, "> ");
    expect(text()).toBe("one\ntwo\nthree");
    // Mixed selection: adds to every line (a press never half-undoes).
    editor("> one\ntwo", 2, 8);
    toggleLinePrefix(view!, "> ");
    expect(text()).toBe("> > one\n> two");
    // A quote without the space still counts as quoted.
    editor(">said", 2);
    toggleLinePrefix(view!, "> ");
    expect(text()).toBe("said");
    // A task is not a bullet.
    editor("- [ ] task", 7);
    toggleLinePrefix(view!, "- ");
    expect(text()).toBe("- - [ ] task");
    editor("- item", 3);
    toggleLinePrefix(view!, "- ");
    expect(text()).toBe("item");
    // Any number counts as numbered; a done task counts as a checklist.
    editor("1. a\n2. b", 1, 8);
    toggleLinePrefix(view!, "1. ");
    expect(text()).toBe("a\nb");
    editor("- [x] done\n- [ ] open", 1, 18);
    toggleLinePrefix(view!, "- [ ] ");
    expect(text()).toBe("done\nopen");
  });

  it("a press undoes what activeFormats reports", () => {
    const quoted = editor("> said", 2, 6);
    expect(activeFormats(quoted.state.doc, 2, 6, 6).has("Quote")).toBe(true);
    toggleLinePrefix(quoted, "> ");
    expect(activeFormats(quoted.state.doc, 0, 4, 4).has("Quote")).toBe(false);
    // Quote is on only when every selected line is quoted.
    const mixed = editor("plain\n> said", 0, 12);
    expect(activeFormats(mixed.state.doc, 0, 12, 12).has("Quote")).toBe(false);
    const h = editor("# Top", 3);
    expect(activeFormats(h.state.doc, 3, 3, 3).has("Heading 1")).toBe(true);
    toggleHeading(h, 1);
    expect(activeFormats(h.state.doc, 1, 1, 1).has("Heading 1")).toBe(false);
  });

  it("insertLink makes the selection a Markdown link", () => {
    editor("see docs here", 4, 8);
    insertLink(view!, 4, 8, "https://example.com");
    expect(text()).toBe("see [docs](https://example.com) here");
  });
});

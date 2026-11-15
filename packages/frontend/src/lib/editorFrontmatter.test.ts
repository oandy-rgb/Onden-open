import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { cursorLineDown } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { frontmatterLength } from "@onden/markdown";
import { editorFrontmatter, frontmatterRange } from "./editorFrontmatter";

// jsdom has no layout: cursorLineDown measures through Range rects.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const views: EditorView[] = [];
function mount(doc: string) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), editorFrontmatter] }),
  });
  views.push(view);
  return view;
}
afterEach(() => { views.splice(0).forEach((v) => { v.destroy(); v.dom.parentElement?.remove(); }); });

const SKILL = "---\ndescription: x\noutput: note\n---\nBody text\n";

describe("editorFrontmatter", () => {
  it("shows a block from line 1 as one small button, not as heading text", () => {
    const view = mount(SKILL);
    const chip = view.dom.querySelector<HTMLButtonElement>("button.cm-frontmatter-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("description · output");
    expect(chip?.getAttribute("aria-expanded")).toBe("false");
    expect(view.dom.textContent).not.toContain("description: x");
    expect(view.dom.textContent).toContain("Body text");
    expect(view.contentDOM.querySelectorAll(".cm-line")).toHaveLength(3); // the button line, "Body text", the empty last line
  });

  it("opens collapsed even though the caret starts at 0", () => {
    const view = mount(SKILL);
    expect(view.state.selection.main.head).toBe(0);
    expect(view.dom.querySelector(".cm-frontmatter-chip")).not.toBeNull();
  });

  it("expands to the raw YAML when the chip is pressed, with no heading class", () => {
    const view = mount(SKILL);
    view.dom.querySelector<HTMLButtonElement>("button.cm-frontmatter-chip")!.click();
    expect(view.dom.querySelector(".cm-frontmatter-chip")).toBeNull();
    expect(view.dom.textContent).toContain("description: x");
    const lines = [...view.dom.querySelectorAll(".cm-frontmatter-line")];
    expect(lines).toHaveLength(4);
    expect(view.dom.querySelectorAll(".cm-frontmatter-line")[0].parentElement).toBe(view.contentDOM);
    expect(view.dom.querySelector('[class*="heading"], [class*="Heading"]')).toBeNull();
    expect(view.state.selection.main.head).toBe(4); // start of the first YAML line
  });

  it("expands when the caret is moved into it, and folds again when it leaves", () => {
    const view = mount(SKILL);
    view.dispatch({ selection: { anchor: 6 }, userEvent: "select" });
    expect(view.dom.querySelector(".cm-frontmatter-chip")).toBeNull();
    expect(view.dom.querySelectorAll(".cm-frontmatter-line")).toHaveLength(4);
    view.dispatch({ selection: { anchor: SKILL.length - 2 }, userEvent: "select" });
    expect(view.dom.querySelector(".cm-frontmatter-chip")).not.toBeNull();
  });

  it("does not expand for a caret placed programmatically", () => {
    const view = mount(SKILL);
    view.dispatch({ selection: { anchor: 6 } });
    expect(view.dom.querySelector(".cm-frontmatter-chip")).not.toBeNull();
  });

  it("leaves a --- rule later in the note, and a lone opening fence, alone", () => {
    for (const doc of ["Intro\n\n---\n\nmore\n", "---\nnever closed\n", "\n---\na: b\n---\n"]) {
      const view = mount(doc);
      expect(view.dom.querySelector(".cm-frontmatter-chip"), doc).toBeNull();
      expect(view.dom.querySelector(".cm-frontmatter-line"), doc).toBeNull();
    }
  });

  it("finds the same block as the markdown package's frontmatter reader", () => {
    for (const doc of [SKILL, "---\n---\nx", "---\na: 1\n---", "---  \r\na: 1\r\n---\r\nbody", "text\n---\n", "---\na\n"]) {
      // CodeMirror keeps one "\n" for a CRLF, so compare on the normalised text.
      const text = doc.replace(/\r\n/g, "\n");
      const range = frontmatterRange(EditorState.create({ doc: text }).doc);
      const len = frontmatterLength(text);
      expect(range ? range.to : 0, JSON.stringify(doc)).toBe(range ? len - (text.slice(0, len).endsWith("\n") ? 1 : 0) : 0);
      expect(!!range).toBe(len > 0);
    }
  });

  it("follows edits: deleting the closing fence removes the button", () => {
    const view = mount(SKILL);
    const close = SKILL.indexOf("---", 4);
    view.dispatch({ changes: { from: close, to: close + 3, insert: "" } });
    expect(view.dom.querySelector(".cm-frontmatter-chip")).toBeNull();
  });

  it("the ↓ key leaves the last YAML line instead of getting stuck on the fence", () => {
    const doc = "---\naliases: a\n---\nBody\n";
    const view = mount(doc);
    view.dispatch({ selection: { anchor: doc.indexOf("\n---\nBody") }, userEvent: "select" });
    cursorLineDown(view);
    cursorLineDown(view);
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(doc.indexOf("Body"));
  });
});

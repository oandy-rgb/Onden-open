// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { codeHighlighter } from "@onden/markdown";
import { codeHighlight, MAX_CHARS, fencedBlocks } from "../lib/editorCodeHighlight";

const views: EditorView[] = [];
function open(doc: string, highlighter = codeHighlighter) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), codeHighlight(highlighter)] }),
    parent: document.body,
  });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}
const classes = (view: EditorView) => [...view.dom.querySelectorAll("[class*=hljs-]")].map((e) => e.className);
const settle = async (view: EditorView) => { await vi.waitFor(() => expect(classes(view).length).toBeGreaterThan(0)); };

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { views.splice(0).forEach((v) => v.destroy()); vi.useRealTimers(); });

describe("editor code colouring", () => {
  it("colours python and haskell fences with the preview's classes", async () => {
    const view = open("```python\ndef f(x):\n    return 1\n```\n\n```haskell\nmain :: IO ()\nmain = pure ()\n```\n");
    await vi.waitFor(() => {
      const text = (lang: string) => [...view.dom.querySelectorAll(".hljs-keyword, .hljs-title, .hljs-type, .hljs-built_in")].some((e) => e.textContent === lang);
      expect(text("def")).toBe(true);
      expect(text("IO") || text("main") || text("pure")).toBe(true);
    });
    expect(view.state.doc.toString()).toContain("def f(x)"); // the text itself is untouched
  });

  it("leaves an unknown language and an untagged block plain", async () => {
    const view = open("```mermaid\ngraph TD\n```\n\n```\nplain\n```\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(classes(view)).toEqual([]);
  });

  it("does not colour a block over the size limit", () => {
    const big = "x = 1\n".repeat(Math.ceil(MAX_CHARS / 6) + 10);
    const view = open("```python\n" + big + "```\n");
    expect(fencedBlocks(view.state, 0, view.state.doc.length)).toEqual([]);
    expect(classes(view)).toEqual([]);
    const many = "\n".repeat(2100);
    expect(fencedBlocks(open("```python\n" + many + "```\n").state, 0, 5000)).toEqual([]);
  });

  it("recolours only the edited block, after a pause", async () => {
    const calls: string[] = [];
    const spy: typeof codeHighlighter = (lang, onLoaded) => {
      const real = codeHighlighter(lang, onLoaded);
      return real && ((text) => { calls.push(text); return real(text); });
    };
    const view = open("```python\na = 1\n```\n\n```sql\nselect 1;\n```\n", spy);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    vi.useFakeTimers();
    const at = view.state.doc.toString().indexOf("a = 1") + 5;
    view.dispatch({ changes: { from: at, insert: "2" } });
    expect(calls.length).toBe(2); // not yet: typing waits
    vi.advanceTimersByTime(250);
    expect(calls.length).toBe(3);
    expect(calls[2]).toContain("a = 12");
  });

  it("waits out an IME composition", async () => {
    const calls: string[] = [];
    const spy: typeof codeHighlighter = (lang, onLoaded) => {
      const real = codeHighlighter(lang, onLoaded);
      return real && ((text) => { calls.push(text); return real(text); });
    };
    const view = open("```python\na = 1\n```\n", spy);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    vi.useFakeTimers();
    vi.spyOn(view, "composing", "get").mockReturnValue(true);
    view.dispatch({ changes: { from: 12, insert: "b" } });
    vi.advanceTimersByTime(1000);
    expect(calls.length).toBe(1);
    vi.spyOn(view, "composing", "get").mockReturnValue(false);
    vi.advanceTimersByTime(400);
    expect(calls.length).toBe(2);
  });
});

describe("loading the colouring on demand", () => {
  it("loads only once a fence is in the note, and then colours it", async () => {
    const { codeHighlightOnDemand } = await import("../lib/editorCodeHighlightOnDemand");
    const view = new EditorView({
      state: EditorState.create({ doc: "just text", extensions: [markdown({ base: markdownLanguage }), codeHighlightOnDemand] }),
      parent: document.body,
    });
    views.push(view);
    view.dispatch({ changes: { from: 9, insert: "\n\n```python\ndef f(): pass\n```\n" } });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({ changes: { from: 0, insert: "" } });
    await settle(view);
    expect(classes(view).length).toBeGreaterThan(0);
  });

  it("also starts when the fence is typed one character at a time", async () => {
    const { codeHighlightOnDemand } = await import("../lib/editorCodeHighlightOnDemand");
    const view = new EditorView({
      state: EditorState.create({ doc: "just text\n", extensions: [markdown({ base: markdownLanguage }), codeHighlightOnDemand] }),
      parent: document.body,
    });
    views.push(view);
    const type = (text: string) => { for (const ch of text) view.dispatch({ changes: { from: view.state.doc.length, insert: ch } }); };
    type("```python\ndef f(): pass\n```");
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({ changes: { from: 0, insert: "" } });
    await settle(view);
    expect(classes(view).length).toBeGreaterThan(0);
  });
});

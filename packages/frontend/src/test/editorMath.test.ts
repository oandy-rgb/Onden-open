import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { mathMarkdown } from "../lib/editorMathSyntax";
import { editorMath, inlineMathSource, mathRanges } from "../lib/editorMath";

const REPORT = "$W_{new} = W + \\Lambda (C^{-1} k_{*})^T$，右邊那串是一個 Rank-1 矩陣… 其中$\\Lambda = \\frac{v_{*} - Wk_{*}}{\\ell \\cdot (C^{-1} k_{*})}$";

function stateOf(doc: string, caret?: number | [number, number]) {
  const state = EditorState.create({
    doc,
    selection: caret === undefined ? undefined : Array.isArray(caret) ? { anchor: caret[0], head: caret[1] } : { anchor: caret },
    extensions: [markdown({ base: markdownLanguage, extensions: [mathMarkdown] }), editorMath],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

describe("which formulas are drawn", () => {
  it("both formulas of the report when the caret is elsewhere", () => {
    const doc = REPORT + "\n\nend";
    const ranges = mathRanges(stateOf(doc, doc.length));
    expect(ranges.map((r) => doc.slice(r.from, r.to))).toEqual([
      "$W_{new} = W + \\Lambda (C^{-1} k_{*})^T$",
      "$\\Lambda = \\frac{v_{*} - Wk_{*}}{\\ell \\cdot (C^{-1} k_{*})}$",
    ]);
    expect(ranges.map((r) => r.display)).toEqual([false, false]);
    expect(ranges[0].source).toBe("W_{new} = W + \\Lambda (C^{-1} k_{*})^T");
  });

  it("the formula under the caret shows its source, the other stays drawn", () => {
    const doc = REPORT;
    const inFirst = doc.indexOf("new");
    const ranges = mathRanges(stateOf(doc, inFirst));
    expect(ranges.map((r) => doc.slice(r.from, r.to).slice(0, 12))).toEqual(["$\\Lambda = \\"]);
  });

  it("the caret on either edge counts as inside; one character away does not", () => {
    const doc = "a $x$ b";
    expect(mathRanges(stateOf(doc, 2))).toHaveLength(0); // just before $
    expect(mathRanges(stateOf(doc, 5))).toHaveLength(0); // just after $
    expect(mathRanges(stateOf(doc, 1))).toHaveLength(1);
    expect(mathRanges(stateOf(doc, 6))).toHaveLength(1);
  });

  it("a selection that overlaps a formula shows it", () => {
    const doc = "a $x$ b $y$ c";
    expect(mathRanges(stateOf(doc, [0, 4])).map((r) => r.source)).toEqual(["y"]);
  });

  it("a block replaces whole lines and is shown by the caret on any of them", () => {
    const doc = "before\n\n$$\nx^2\n  + y\n$$\n\nafter";
    const [block] = mathRanges(stateOf(doc, 0));
    expect(block).toMatchObject({ display: true, source: "x^2\n  + y" });
    expect(doc.slice(block.from, block.to)).toBe("$$\nx^2\n  + y\n$$");
    expect(mathRanges(stateOf(doc, doc.indexOf("x^2")))).toHaveLength(0);
    expect(mathRanges(stateOf(doc, doc.indexOf("$$")))).toHaveLength(0);
  });

  it("stays source: empty formulas, blocks inside quotes or lists, an unparsed `$5`", () => {
    expect(mathRanges(stateOf("a $ $ b", 0))).toHaveLength(0);
    expect(mathRanges(stateOf("$$\n$$\n", 0))).toHaveLength(0);
    expect(mathRanges(stateOf("> $$\n> x\n> $$\n", 0))).toHaveLength(0);
    expect(mathRanges(stateOf("- $$\n  x\n  $$\n", 0))).toHaveLength(0);
    expect(mathRanges(stateOf("only $5 here", 0))).toHaveLength(0);
  });

  it("strips one space on each side like the published page", () => {
    expect(inlineMathSource("$ a $", 1)).toBe("a");
    expect(inlineMathSource("$$ a b $$", 2)).toBe("a b");
    expect(inlineMathSource("$a $", 1)).toBe("a ");
    expect(inlineMathSource("$  $", 1)).toBe("  ");
  });
});

describe("the editor view", () => {
  let view: EditorView | null = null;
  afterEach(() => { view?.destroy(); view = null; document.body.innerHTML = ""; });

  function mount(doc: string, caret: number) {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: caret },
        extensions: [markdown({ base: markdownLanguage, extensions: [mathMarkdown] }), editorMath],
      }),
    });
    ensureSyntaxTree(view.state, doc.length, 5000);
    view.dispatch({}); // lets the field see the finished tree
    return view;
  }

  const katexShown = () => new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (document.querySelector(".cm-math .katex")) resolve();
      else if (Date.now() - started > 5000) reject(new Error("KaTeX never drew"));
      else setTimeout(tick, 10);
    };
    tick();
  });

  it("draws KaTeX away from the caret and the source when the caret is inside", async () => {
    const doc = REPORT + "\n\nend";
    const v = mount(doc, doc.length);
    // Before KaTeX arrives the source is what shows.
    expect(document.querySelectorAll(".cm-math").length).toBe(2);
    await katexShown();
    expect(document.querySelectorAll(".cm-math .katex").length).toBe(2);
    expect(v.dom.querySelector(".cm-content em")).toBeNull();

    v.dispatch({ selection: { anchor: doc.indexOf("new") } });
    expect(document.querySelectorAll(".cm-math").length).toBe(1);
    expect(v.contentDOM.textContent).toContain("W_{new}");
  });

  it("a block is drawn in display mode", async () => {
    mount("$$\nx^2\n$$\n\nend", 12);
    await katexShown();
    expect(document.querySelector(".cm-math-block .katex-display")).not.toBeNull();
  });

  it("a formula KaTeX rejects keeps its source with the error style and does not throw", async () => {
    const doc = "a $\\frac{1$ b\n\n$\\notacommand$ c\n\nend";
    mount(doc, doc.length);
    await new Promise((r) => setTimeout(r, 300));
    const bad = document.querySelectorAll(".cm-math-error");
    expect(bad.length).toBe(2);
    expect(bad[0].textContent).toBe("$\\frac{1$");
    expect(bad[0].getAttribute("title")).toBeTruthy();
    expect(bad[0].querySelector(".katex")).toBeNull();
  });

  it("tapping a drawn formula puts the caret inside it", async () => {
    const doc = "a $x_1$ b\n\nend";
    const v = mount(doc, doc.length);
    await katexShown();
    const widget = v.contentDOM.querySelector(".cm-math-inline") as HTMLElement;
    widget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(v.state.selection.main.head).toBe(3); // right after the opening $
    expect(v.contentDOM.textContent).toContain("$x_1$");
    expect(v.contentDOM.querySelector(".cm-math")).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorSelectionTools } from "./editorSelectionTools";
import { editorMarkdownLanguage, mdHighlight } from "./editorMarkdownLanguage";

const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach((v) => { v.destroy(); v.dom.parentElement?.remove(); }); });

describe("inline code takes no width from its pieces", () => {
  it("has no horizontal padding, because a selection's same-word marks cut a code span into pieces", () => {
    const parent = document.body.appendChild(document.createElement("div"));
    const doc = "`yytext` 與 `yytext`";
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [editorMarkdownLanguage(), syntaxHighlighting(mdHighlight), editorSelectionTools()] }),
    });
    views.push(view);
    view.dispatch({ selection: { anchor: 1, head: 4 } });
    const pieces = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line span")].filter((span) => span.textContent === "yyt" || span.textContent === "ext");
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    for (const piece of pieces) {
      const style = getComputedStyle(piece);
      expect(style.paddingLeft === "" || style.paddingLeft === "0px").toBe(true);
      expect(style.paddingRight === "" || style.paddingRight === "0px").toBe(true);
    }
  });
});

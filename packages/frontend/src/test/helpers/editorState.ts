import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { mathMarkdown } from "../../lib/editorMathSyntax";

/** An editor state with the markdown grammar the editor uses (code and formulas parse as in the app). */
export function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [mathMarkdown] })] });
}

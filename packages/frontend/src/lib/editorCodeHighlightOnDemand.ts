import { type Extension, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// The start-up half of editorCodeHighlight: a few lines that watch for the
// first ``` / ~~~ in the note (open, pasted or typed) and only then load the real
// extension, so a note without code costs the start-up bundle nothing.

const FENCE = /```|~~~/;

export const codeHighlightOnDemand: Extension = ViewPlugin.fromClass(class {
  private started = false;
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private view: EditorView) {
    if (FENCE.test(view.state.doc.toString())) this.start();
  }

  update(u: ViewUpdate) {
    if (this.started || !u.docChanged) return;
    // Look at the lines the edit touched in the new document, not at the inserted text: a fence typed
    // one character at a time is three separate one-character insertions.
    const doc = u.state.doc;
    let found = false;
    u.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      for (let n = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; n <= last && !found; n++) found = FENCE.test(doc.line(n).text);
    });
    if (found) this.start();
  }

  destroy() { clearTimeout(this.timer); this.destroyed = true; }

  private start() {
    this.started = true;
    void import("./editorCodeHighlight").then(({ codeHighlight }) => this.install(codeHighlight));
  }

  /** Never reconfigure in the middle of an IME composition. */
  private install(make: () => Extension) {
    if (this.destroyed) return;
    if (this.view.composing) { this.timer = setTimeout(() => this.install(make), 300); return; }
    this.view.dispatch({ effects: StateEffect.appendConfig.of(make()) });
  }
});

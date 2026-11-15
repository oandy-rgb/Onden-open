import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// Whether an IME is composing, as editor state. A transaction filter or a
// decoration field has no view to ask, so the view tells the state. While it
// is true nothing the editor draws (a widget, a decoration) is added, removed
// or replaced and no hidden mark is moved: the composed text is the browser's
// until the candidate is chosen. Every extension that draws over the text
// (editorBlocks, editorCheckboxes, editorCallouts, editorTables) reads this one.

const setComposing = StateEffect.define<boolean>();

export const composingField = StateField.define<boolean>({
  create: () => false,
  update(on, tr) {
    for (const e of tr.effects) if (e.is(setComposing)) return e.value;
    return on;
  },
});

export const trackComposing = EditorView.domEventHandlers({
  compositionstart(_event, view) { view.dispatch({ effects: setComposing.of(true) }); return false; },
  compositionend(_event, view) { view.dispatch({ effects: setComposing.of(false) }); return false; },
});

/** The composition has just ended in this update: whatever was held back is drawn now. */
export function composingEnded(update: ViewUpdate): boolean {
  return update.startState.field(composingField, false) === true && update.state.field(composingField, false) === false;
}

/** A plugin whose decorations come from `build` over the visible text. While an IME is composing they are held
 *  back (positions follow the edit, nothing appears or goes); they are built again when the text, the viewport or
 *  the parse changes, and the moment the composition ends. `provide` adds facets that read the decorations. */
export function composingSafeDecorations(
  build: (view: EditorView) => DecorationSet,
  provide?: (plugin: ViewPlugin<{ decorations: DecorationSet }>) => Extension,
): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) {
      if (u.view.composing || u.state.field(composingField, false)) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (u.docChanged || u.viewportChanged || composingEnded(u) || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  }, { decorations: (p) => p.decorations, provide: provide ? (p) => provide(p) : undefined });
  return [composingField, trackComposing, plugin];
}

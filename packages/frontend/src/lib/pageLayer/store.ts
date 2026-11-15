// What the controllers of a note's page layers — the text boxes (lib/pageText)
// and the pictures (lib/pageImages) — have in common: the document and its
// undo / redo stacks (snapshots: one undo is one decision), the one selected
// item, subscribers (useSyncExternalStore), and saving a settled value with
// the value it was made from. A layer adds its own edits and says when each
// one is saved; it does not keep a second copy of any of this.
//
// A value a newer version wrote (readOnly) is shown and refuses every edit, so
// nothing the layer does not understand is rewritten.

const HISTORY_LIMIT = 100;

/** The item being worked on. One for the whole note. */
export type LayerSelection = { pageKey: string; id: string };

export abstract class PageLayerStore<Doc, Sel extends LayerSelection> {
  protected doc: Doc;
  protected past: Doc[] = [];
  protected future: Doc[] = [];
  /** The value the next save is made from (what was loaded, then each save). */
  protected base: string | null;
  protected saved: string;
  protected selection: Sel | null = null;
  protected readonly readOnlyValue: boolean;
  private readonly listeners = new Set<() => void>();

  /** `encode` makes the settled stored value of a document; `save` writes one
   *  (with the value it was made from). */
  protected constructor(
    doc: Doc,
    initial: string | null,
    readOnly: boolean,
    private readonly encode: (doc: Doc) => string,
    private readonly write: (value: string, base: string | null) => void,
  ) {
    this.doc = doc;
    this.base = initial;
    this.saved = encode(doc);
    this.readOnlyValue = readOnly;
  }

  // ── Reading (useSyncExternalStore: subscribe + getSnapshot) ────────────────

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = (): Doc => this.doc;
  readonly getSelection = (): Sel | null => this.selection;

  get readOnly(): boolean { return this.readOnlyValue; }
  get canUndo(): boolean { return !this.readOnlyValue && this.past.length > 0; }
  get canRedo(): boolean { return !this.readOnlyValue && this.future.length > 0; }

  undo(): boolean { return this.travel(this.past, this.future); }
  redo(): boolean { return this.travel(this.future, this.past); }

  // ── For the layer ──────────────────────────────────────────────────────────

  /** Whether the selected item is still in the document (a removal clears the selection). */
  protected abstract hasSelected(selection: Sel): boolean;
  /** An undo or redo moved the document (the layer closes any step it had open). */
  protected travelled(): void {}

  /** Put the current document on the undo stack, ahead of an edit; the redo stack is dropped. */
  protected stack(): void {
    this.past.push(this.doc);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  private travel(from: Doc[], to: Doc[]): boolean {
    const target = this.readOnlyValue ? undefined : from.pop();
    if (!target) return false;
    to.push(this.doc);
    this.doc = target;
    this.travelled();
    this.emit();
    this.persist();
    return true;
  }

  /** Write the document if it differs from the last save. */
  protected persist(): void {
    if (this.readOnlyValue) return;
    const value = this.encode(this.doc);
    if (value === this.saved) return;
    const base = this.base;
    this.saved = value;
    this.base = value;
    this.write(value, base);
  }

  protected emit(): void {
    const sel = this.selection;
    if (sel && !this.hasSelected(sel)) this.selection = null;
    for (const listener of this.listeners) listener();
  }
}

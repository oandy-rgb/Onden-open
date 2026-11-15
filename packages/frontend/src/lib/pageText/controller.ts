// The text boxes of one note, as the page surfaces edit them (@onden/markdown/
// page-text is the stored format). One controller per open note; every page —
// a PDF page, a handwriting page, later a slide — reads and edits its boxes by
// pageKey, so a surface only supplies "which page" and "where is the page".
//
// What it owns, so a surface does not:
//   - the document and its undo stack (snapshots: it is small, and one undo is
//     one decision — a box added, a drag, a whole typing burst);
//   - when to save: typing waits for a pause (SAVE_PAUSE_MS), a finished
//     move / resize / style / delete / undo saves at once, and commit() (a tap
//     elsewhere, leaving the page) saves what is pending. A drag previews and
//     saves once on release. Each save is one lib/data savePageText write.
//   - what is saved: boxes without text are left out (an empty box is removed
//     when its editing ends; it never reaches the server), and a value equal to
//     the last save is not written again.
//
// A note whose value a newer version wrote (isPageTextReadOnly) shows its boxes
// and refuses every edit, so nothing it does not understand is rewritten.

import { PageLayerStore } from "../pageLayer";
import {
  PAGE_TEXT_DEFAULT_SIZE, PAGE_TEXT_DEFAULT_WIDTH, PAGE_TEXT_MIN_WIDTH, decodePageText, encodePageText, isPageTextReadOnly,
  type PageTextBox, type PageTextDoc,
} from "@onden/markdown/page-text";
import { randomUUID } from "../uuid";

/** How long typing may pause before it is saved. */
export const SAVE_PAUSE_MS = 1000;
export type PageTextControllerOptions = {
  /** The note's stored value as loaded (null: none yet). */
  initial: string | null;
  /** Write a settled value; `base` is what it was made from (lib/data savePageText). */
  save: (value: string, base: string | null) => void;
  readOnly?: boolean;
  /** Test seams. */
  now?: () => Date;
  newId?: () => string;
};

/** The box being worked on, and whether its text is being typed. One for the
 *  whole note: starting on another page's box ends this one. */
export type BoxSelection = { pageKey: string; id: string; editing: boolean };

export type NewBox = Partial<Pick<PageTextBox, "x" | "y" | "w" | "text" | "size" | "color" | "align">>;
export type BoxGeometry = Partial<Pick<PageTextBox, "x" | "y" | "w">>;
export type BoxStyle = Partial<Pick<PageTextBox, "size" | "color" | "align">>;

/** The value that gets saved: the boxes that have text. */
function settledValue(doc: PageTextDoc): string {
  const pages: PageTextDoc["pages"] = {};
  for (const [key, page] of Object.entries(doc.pages)) {
    pages[key] = { ...page, boxes: page.boxes.filter((box) => box.text.trim() !== "") };
  }
  return encodePageText({ ...doc, pages });
}

export class PageTextController extends PageLayerStore<PageTextDoc, BoxSelection> {
  /** The kind of edit the open undo step is made of; further edits of it
   *  (more typing in one box, more of one drag) join the step. */
  private openStep: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: PageTextControllerOptions;

  constructor(opts: PageTextControllerOptions) {
    super(decodePageText(opts.initial), opts.initial, opts.readOnly === true || isPageTextReadOnly(opts.initial), settledValue, opts.save);
    this.opts = opts;
  }

  boxes(pageKey: string): readonly PageTextBox[] { return this.doc.pages[pageKey]?.boxes ?? []; }
  box(pageKey: string, id: string): PageTextBox | undefined { return this.boxes(pageKey).find((box) => box.id === id); }

  // ── Editing ────────────────────────────────────────────────────────────────

  /** Add a box and return it (undefined when read-only). It is not saved
   *  until it has text. */
  addBox(pageKey: string, box: NewBox): PageTextBox | undefined {
    if (this.readOnlyValue) return undefined;
    const created: PageTextBox = {
      id: (this.opts.newId ?? randomUUID)(),
      x: box.x ?? 0, y: box.y ?? 0, w: Math.max(PAGE_TEXT_MIN_WIDTH, box.w ?? PAGE_TEXT_DEFAULT_WIDTH),
      text: box.text ?? "", size: box.size ?? PAGE_TEXT_DEFAULT_SIZE, color: box.color ?? "#1f1f1f", align: box.align ?? "left",
      updated_at: this.stamp(),
    };
    this.change(`add:${created.id}`, (boxes) => [...boxes, created], pageKey, "pause");
    return created;
  }

  /** Typing: one undo step per burst, saved after a pause. */
  setText(pageKey: string, id: string, text: string): void {
    this.edit(pageKey, id, { text }, `text:${id}`, "pause");
  }

  /** A drag in progress: the box follows, nothing is saved or stacked yet
   *  (the release, setGeometry, is the one step). */
  preview(pageKey: string, id: string, geometry: BoxGeometry): void {
    this.edit(pageKey, id, this.clampGeometry(geometry), `move:${id}`, "none");
  }

  /** A finished move / resize: one undo step, saved now. */
  setGeometry(pageKey: string, id: string, geometry: BoxGeometry): void {
    this.edit(pageKey, id, this.clampGeometry(geometry), `move:${id}`, "now");
    this.openStep = null;
  }

  /** Size, colour or alignment: one undo step, saved now. */
  setStyle(pageKey: string, id: string, style: BoxStyle): void {
    this.edit(pageKey, id, style, `style:${id}`, "now");
    this.openStep = null;
  }

  removeBox(pageKey: string, id: string): void {
    this.change(`remove:${id}`, (boxes) => boxes.filter((box) => box.id !== id), pageKey, "now");
    this.openStep = null;
  }

  select(pageKey: string, id: string, editing = false): void {
    const now = this.selection;
    if (now && now.pageKey === pageKey && now.id === id && now.editing === editing) return;
    this.selection = { pageKey, id, editing };
    this.emit();
  }

  /** Ends the selection; a box left without text goes with it. */
  clearSelection(): void {
    const now = this.selection;
    if (!now) return;
    this.selection = null;
    const box = this.box(now.pageKey, now.id);
    if (!box || box.text.trim() !== "") { this.emit(); return; }
    // A box added and left empty was never an edit: it leaves no undo step.
    const before = this.openStep === `add:${now.id}` ? this.past.pop() : undefined;
    if (before) { this.doc = before; this.openStep = null; this.emit(); }
    else this.removeBox(now.pageKey, now.id);
  }

  /** Save what is pending now and close the open undo step: a tap elsewhere,
   *  leaving the page (pagehide), leaving the note. */
  commit(): void {
    this.openStep = null;
    this.persist();
  }

  /** The surface goes away: save the rest. (Effects may run twice in
   *  development, so the controller stays usable.) */
  dispose(): void { this.commit(); }

  // ── Internals ──────────────────────────────────────────────────────────────

  private stamp(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }

  private clampGeometry(g: BoxGeometry): BoxGeometry {
    return g.w === undefined ? g : { ...g, w: Math.max(PAGE_TEXT_MIN_WIDTH, g.w) };
  }

  private edit(pageKey: string, id: string, patch: Partial<PageTextBox>, step: string, save: "pause" | "now" | "none"): void {
    if (!this.box(pageKey, id)) return;
    const changed = Object.entries(patch).some(([k, v]) => this.box(pageKey, id)![k as keyof PageTextBox] !== v);
    // A release that changes nothing more than its preview still saves the preview.
    if (!changed) { if (save === "now") this.persist(); return; }
    this.change(step, (boxes) => boxes.map((box) => (box.id === id ? { ...box, ...patch, updated_at: this.stamp() } : box)), pageKey, save);
  }

  private change(step: string, apply: (boxes: readonly PageTextBox[]) => PageTextBox[], pageKey: string, save: "pause" | "now" | "none"): void {
    if (this.readOnlyValue) return;
    if (this.openStep !== step) {
      this.stack();
      this.openStep = step;
    }
    this.future = [];
    const page = this.doc.pages[pageKey];
    this.doc = { ...this.doc, pages: { ...this.doc.pages, [pageKey]: { ...page, boxes: apply(page?.boxes ?? []) } } };
    this.emit();
    if (save === "now") this.persist();
    else if (save === "pause") this.schedule();
  }

  protected override travelled(): void { this.openStep = null; }

  protected override hasSelected(selection: BoxSelection): boolean { return this.box(selection.pageKey, selection.id) !== undefined; }

  /** Saving now also cancels the pause that was counting down to it. */
  protected override persist(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    super.persist();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_PAUSE_MS);
  }
}

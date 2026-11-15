// The pictures of one note, as the page surfaces edit them (@onden/markdown/
// page-images is the stored format). One controller per open note; a page reads
// and edits its pictures by pageKey. The sibling of lib/pageText, smaller:
// there is nothing to type, so every finished edit is one undo step and one
// save (SAVE is immediate), and a drag previews until the pointer is released.
//
// What it owns, so a surface does not:
//   - the document and its undo stack (snapshots: one undo is one decision —
//     a picture added, a drag, a resize, a removal);
//   - when to save: a finished add / move / resize / removal / undo saves at
//     once, one lib/data savePageImages write each; a value equal to the last
//     save is not written again;
//   - the selection (which picture the handles show).
//
// A note whose value a newer version wrote (isPageImagesReadOnly) shows its
// pictures and refuses every edit, so nothing it does not understand is rewritten.

import { PageLayerStore, type LayerSelection } from "../pageLayer";
import {
  PAGE_IMAGE_MIN_SIDE, decodePageImages, encodePageImages, isPageImagesReadOnly,
  type PageImage, type PageImagesDoc,
} from "@onden/markdown/page-images";
import { randomUUID } from "../uuid";

export type PageImagesControllerOptions = {
  /** The note's stored value as loaded (null: none yet). */
  initial: string | null;
  /** Write a settled value; `base` is what it was made from (lib/data savePageImages). */
  save: (value: string, base: string | null) => void;
  readOnly?: boolean;
  /** Test seams. */
  now?: () => Date;
  newId?: () => string;
};

/** The picture being worked on. One for the whole note. */
export type ImageSelection = LayerSelection;

export type NewImage = Pick<PageImage, "x" | "y" | "w" | "h" | "src" | "alt">;
export type ImageRect = Partial<Pick<PageImage, "x" | "y" | "w" | "h">>;

export class PageImagesController extends PageLayerStore<PageImagesDoc, ImageSelection> {
  /** A drag in progress has not been stacked yet: its first preview stacks the
   *  document it started from once, and the release closes the step. */
  private dragging: string | null = null;
  private readonly opts: PageImagesControllerOptions;

  constructor(opts: PageImagesControllerOptions) {
    super(decodePageImages(opts.initial), opts.initial, opts.readOnly === true || isPageImagesReadOnly(opts.initial), encodePageImages, opts.save);
    this.opts = opts;
  }

  images(pageKey: string): readonly PageImage[] { return this.doc.pages[pageKey]?.images ?? []; }
  image(pageKey: string, id: string): PageImage | undefined { return this.images(pageKey).find((image) => image.id === id); }

  // ── Editing ────────────────────────────────────────────────────────────────

  /** Put a picture on top of the page's others and select it. One undo step, saved now. */
  addImage(pageKey: string, image: NewImage): PageImage | undefined {
    if (this.readOnlyValue) return undefined;
    const created: PageImage = {
      id: (this.opts.newId ?? randomUUID)(),
      x: image.x, y: image.y, w: Math.max(PAGE_IMAGE_MIN_SIDE, image.w), h: Math.max(PAGE_IMAGE_MIN_SIDE, image.h),
      src: image.src, alt: image.alt, updated_at: this.stamp(),
    };
    this.change(pageKey, (images) => [...images, created]);
    this.persist();
    this.select(pageKey, created.id);
    return created;
  }

  /** A drag in progress: the picture follows, nothing is saved or stacked as a
   *  step yet (the release, setRect, is the one step). */
  preview(pageKey: string, id: string, rect: ImageRect): void {
    if (this.readOnlyValue || !this.image(pageKey, id)) return;
    if (this.dragging !== id) { this.stack(); this.dragging = id; }
    this.replace(pageKey, id, rect);
  }

  /** A finished move / resize: one undo step, saved now. */
  setRect(pageKey: string, id: string, rect: ImageRect): void {
    if (this.readOnlyValue || !this.image(pageKey, id)) return;
    if (this.dragging === id) this.dragging = null; // its step was stacked by the first preview
    else if (!this.changes(pageKey, id, rect)) return;
    else this.stack();
    this.replace(pageKey, id, rect);
    this.persist();
  }

  /** A drag that was cancelled: the picture goes back to where it started. */
  cancelPreview(): void {
    if (this.dragging === null) return;
    this.dragging = null;
    const before = this.past.pop();
    if (before) { this.doc = before; this.emit(); }
  }

  removeImage(pageKey: string, id: string): void {
    if (this.readOnlyValue || !this.image(pageKey, id)) return;
    this.change(pageKey, (images) => images.filter((image) => image.id !== id));
    this.persist();
  }

  select(pageKey: string, id: string): void {
    const now = this.selection;
    if (now && now.pageKey === pageKey && now.id === id) return;
    this.selection = { pageKey, id };
    this.emit();
  }

  clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    this.emit();
  }

  /** Save what is pending now (a release that was not delivered, leaving the note). */
  commit(): void {
    this.dragging = null;
    this.persist();
  }

  /** The surface goes away: save the rest. (Effects may run twice in
   *  development, so the controller stays usable.) */
  dispose(): void { this.commit(); }

  // ── Internals ──────────────────────────────────────────────────────────────

  private stamp(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }

  private changes(pageKey: string, id: string, rect: ImageRect): boolean {
    const now = this.image(pageKey, id)!;
    return Object.entries(rect).some(([k, v]) => now[k as keyof ImageRect] !== v);
  }

  private replace(pageKey: string, id: string, rect: ImageRect): void {
    const clamped: ImageRect = {
      ...rect,
      ...(rect.w === undefined ? {} : { w: Math.max(PAGE_IMAGE_MIN_SIDE, rect.w) }),
      ...(rect.h === undefined ? {} : { h: Math.max(PAGE_IMAGE_MIN_SIDE, rect.h) }),
    };
    this.setImages(pageKey, (images) => images.map((image) => (image.id === id ? { ...image, ...clamped, updated_at: this.stamp() } : image)));
  }

  /** One undoable edit of a page's pictures. */
  private change(pageKey: string, apply: (images: readonly PageImage[]) => PageImage[]): void {
    this.stack();
    this.setImages(pageKey, apply);
  }

  private setImages(pageKey: string, apply: (images: readonly PageImage[]) => PageImage[]): void {
    const page = this.doc.pages[pageKey];
    this.doc = { ...this.doc, pages: { ...this.doc.pages, [pageKey]: { ...page, images: apply(page?.images ?? []) } } };
    this.emit();
  }

  protected override travelled(): void { this.dragging = null; }

  protected override hasSelected(selection: ImageSelection): boolean { return this.image(selection.pageKey, selection.id) !== undefined; }
}

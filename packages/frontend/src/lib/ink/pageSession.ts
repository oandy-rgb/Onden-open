// Edit bookkeeping for hosts that show a book of pages, each with its own InkEngine (a PDF, a
// handwriting notebook): which engines are up, whose edits are not yet in the saved drawing, and
// which page undo and redo go to.
//
// Each page that is near the screen mounts an engine holding the page's drawing in page units
// (lib/pdf/pageUnits.ts for a PDF), so the engine's document IS the page: edits — strokes drawn,
// spans erased, an erase undone — are the page's new drawing, whatever the zoom. The session
// remembers every engine so edits outlive the engines themselves: a page that scrolls away
// (or a tool that is switched off) unmounts its engine mid-session.
//
// `apply` is the single way edits reach the host's envelope: it writes every page that changed
// since its last apply, so calling it again (settle timer, tool change, unmount, an engine
// leaving, the page going away) is harmless and one call is one edit. How one page's drawing is
// written into the envelope is the host's (`writePage`): the session knows pages only by key.

import type { InkEngine } from "./engine";
import type { InkDocument } from "./types";

/** Puts `doc` — page `key`, `ratio` = its height / width — into `envelope`; the same object when
 *  nothing needs writing. */
export type WritePage<Envelope> = (envelope: Envelope, key: string, doc: InkDocument, ratio: number) => Envelope;

interface Surface {
  engine: InkEngine;
  key: string;
  ratio: number;
  /** Signature of the engine content as last written to (or loaded from) the envelope. */
  applied: string;
}

/** What changed in an engine page: a cheap equality key (strokes and shapes are
 *  immutable once committed, so ids + erased intervals say everything). */
export function pageSignature(doc: InkDocument): string {
  return `${doc.strokes.map((s) => s.id).join(",")}|${JSON.stringify(doc.erased)}|${(doc.shapes ?? []).map((s) => s.id).join(",")}`;
}

export class InkPageSession<Envelope> {
  private surfaces = new Map<string, Surface>();
  /** Surfaces that unmounted with edits not yet written, with their last content. */
  private retired: Array<{ key: string; ratio: number; doc: InkDocument }> = [];
  /** Pages by recency of the last pen/finger down: undo and redo go to the
   *  page being worked on, then to the others. */
  private recent: string[] = [];
  private pointersDown = 0;
  private settlePending = false;
  /** Called when the strokes have settled (no pen down, debounce elapsed):
   *  the host commits then, so ink is saved without leaving drawing mode. */
  onSettled: (() => void) | null = null;
  /** Undo / redo availability changed (any surface). */
  onHistoryChange: ((canUndo: boolean, canRedo: boolean) => void) | null = null;

  constructor(private readonly writePage: WritePage<Envelope>) {}

  /** A surface's engine reported a change (debounced). Commit once the pen is up. */
  strokesChanged(): void {
    if (this.pointersDown > 0) { this.settlePending = true; return; }
    this.settlePending = false;
    this.onSettled?.();
  }

  pointerDown(): void { this.pointersDown += 1; }

  pointerUp(): void {
    this.pointersDown = Math.max(0, this.pointersDown - 1);
    if (this.pointersDown === 0 && this.settlePending) this.strokesChanged();
  }

  touched(key: string): void {
    this.recent = [key, ...this.recent.filter((k) => k !== key)];
  }

  historyChanged(): void {
    const engines = [...this.surfaces.values()].map((s) => s.engine);
    this.onHistoryChange?.(engines.some((e) => e.canUndo()), engines.some((e) => e.canRedo()));
  }

  /** Surfaces in the order undo / redo should try them. */
  private byRecency(): Surface[] {
    const order = [...this.recent, ...this.surfaces.keys()];
    return [...new Set(order)].flatMap((key) => this.surfaces.get(key) ?? []);
  }

  undo(): void {
    const target = this.byRecency().find((s) => s.engine.canUndo());
    if (target) { this.touched(target.key); target.engine.undo(); }
  }

  redo(): void {
    const target = this.byRecency().find((s) => s.engine.canRedo());
    if (target) { this.touched(target.key); target.engine.redo(); }
  }

  /** Space held: mouse / pen drags pan instead of drawing, on every page. */
  setSpaceHeld(held: boolean): void {
    for (const surface of this.surfaces.values()) surface.engine.setSpaceHeld(held);
  }

  /** Clear: every surface starts over empty (the host writes the empty envelope). */
  reset(): void {
    this.retired = [];
    for (const surface of this.surfaces.values()) {
      surface.engine.load(null);
      surface.applied = pageSignature(surface.engine.serialize());
    }
  }

  /** A page surface mounted; `engine` already holds the page's drawing. */
  attach(key: string, engine: InkEngine, ratio: number): void {
    this.surfaces.set(key, { engine, key, ratio, applied: pageSignature(engine.serialize()) });
    this.historyChanged();
  }

  /** Surface unmounting (page evicted / mode exit): keep its unwritten edits
   *  for the next apply, and ask for it now — the page may remount (reading the
   *  envelope) before the settle timer would. */
  detach(key: string, engine: InkEngine): void {
    const surface = this.surfaces.get(key);
    if (surface?.engine !== engine) return;
    this.surfaces.delete(key);
    this.historyChanged();
    const doc = engine.serialize();
    if (pageSignature(doc) === surface.applied) return;
    this.retired.push({ key, ratio: surface.ratio, doc });
    this.onSettled?.();
  }

  /** The envelope with every unwritten edit applied; the same object when
   *  there is nothing to write. */
  apply(envelope: Envelope): Envelope {
    let next = envelope;
    const retired = this.retired;
    this.retired = [];
    for (const { key, ratio, doc } of retired) next = this.writePage(next, key, doc, ratio);
    for (const surface of this.surfaces.values()) {
      const doc = surface.engine.serialize();
      const signature = pageSignature(doc);
      if (signature === surface.applied) continue;
      surface.applied = signature;
      next = this.writePage(next, surface.key, doc, surface.ratio);
    }
    return next;
  }
}

/** What a page's ink surface asks of the session whatever the envelope is (PageInkSurface). */
export type PageSurfaceSession = Pick<InkPageSession<unknown>, "historyChanged" | "strokesChanged" | "pointerDown" | "pointerUp" | "touched" | "attach" | "detach">;

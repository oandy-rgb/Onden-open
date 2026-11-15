// Pure ink document model: strokes + erased intervals + undo/redo stack +
// serialize/load. DOM-free so the whole mutation surface is unit-testable;
// InkEngine layers the canvases / pointer pipeline on top.

import { isInkReadOnly } from "@onden/markdown/ink";
import { mergeIntervals } from "./erase";
import { shapeMaxY } from "./shapes";
import {
  emptyInkDocument,
  INK_DEFAULT_PAGE_WIDTH,
  type EraseInterval,
  type ErasedIntervals,
  type InkDocument,
  type InkOp,
  type InkShape,
  type InkStroke,
} from "./types";

// What the model manages: strokes, erasure, shapes, page width/background.
// Everything else a loaded drawing carries — `features`/`requires`, and any field
// a newer app added at document or page level — is kept as loaded and written
// back by serialize(); the server merge would otherwise read each missing field
// as "deleted on this side" (@onden/markdown/ink, Format evolution).
const MANAGED_DOC_KEYS = new Set(["version", "strokes", "erased", "page", "shapes"]);
const MANAGED_PAGE_KEYS = new Set(["width", "background"]);

const omit = (source: object, keys: ReadonlySet<string>): Record<string, unknown> =>
  structuredClone(Object.fromEntries(Object.entries(source).filter(([key]) => !keys.has(key))));

function cloneIntervals(intervals: EraseInterval[] | undefined): EraseInterval[] {
  return (intervals ?? []).map((iv) => [iv[0], iv[1]] as EraseInterval);
}

function cloneStroke(stroke: InkStroke): InkStroke {
  return { ...stroke, points: stroke.points.map((p) => [...p] as InkStroke["points"][number]) };
}

export class InkModel {
  strokes: InkStroke[] = [];
  erased: ErasedIntervals = {};
  pageWidth = INK_DEFAULT_PAGE_WIDTH;
  background: string | undefined;
  /** Shapes, in drawing order. A kind this version cannot draw stays in the
   *  list as stored (it is only skipped when drawing). */
  shapes: InkShape[] = [];
  /** The drawing has (or had) a `shapes` array, even an empty one: write it back. */
  private hadShapes = false;
  /** Loaded, unmanaged parts of the drawing (see MANAGED_DOC_KEYS). */
  private docExtras: Record<string, unknown> = {};
  private pageExtras: Record<string, unknown> = {};
  /** The drawing needs a newer version to edit (`requires`): every edit is
   *  refused and the loaded data serializes back unchanged. */
  readOnly = false;

  private undoStack: InkOp[] = [];
  private redoStack: InkOp[] = [];
  /** Told of every new edit (not of undo/redo), so a host with one history for the
   *  whole board can register it there. */
  onRecord: ((op: InkOp) => void) | undefined;

  private record(op: InkOp): void {
    this.undoStack.push(op);
    this.redoStack = [];
    this.onRecord?.(op);
  }

  /** Commit a finished stroke (immutable from here on). */
  addStroke(stroke: InkStroke): void {
    if (this.readOnly) return;
    this.strokes.push(stroke);
    this.record({ type: "add", stroke });
  }

  /** Commit a finished shape. */
  addShape(shape: InkShape): void {
    if (this.readOnly) return;
    this.hadShapes = true;
    this.shapes.push(shape);
    this.record({ type: "addShape", shape });
  }

  /** Commit `shape` in place of `stroke` (a pen held still: the stroke becomes
   *  the shape it was meant to be). Undo is one step back to the stroke. */
  snapStrokeToShape(stroke: InkStroke, shape: InkShape): void {
    if (this.readOnly) return;
    this.hadShapes = true;
    this.shapes.push(shape);
    this.record({ type: "snap", stroke, shape });
  }

  /**
   * Apply one eraser drag's outcome: the full (already merged) interval set
   * per affected stroke, and the shapes it touched (removed whole). Records a
   * single undo op carrying before/after snapshots so the whole drag undoes in
   * one step.
   */
  applyErase(after: Record<string, EraseInterval[]>, shapeIds: ReadonlySet<string> = new Set()): void {
    if (this.readOnly) return;
    const ids = Object.keys(after);
    const shapes = this.shapes.filter((shape) => shapeIds.has(shape.id));
    if (ids.length === 0 && shapes.length === 0) return;
    this.shapes = this.shapes.filter((shape) => !shapeIds.has(shape.id));
    const before: ErasedIntervals = {};
    const normalized: ErasedIntervals = {};
    for (const id of ids) {
      before[id] = cloneIntervals(this.erased[id]);
      normalized[id] = mergeIntervals(after[id]);
      this.erased[id] = cloneIntervals(normalized[id]);
    }
    this.record({ type: "erase", before, after: normalized, shapes });
  }

  /** Move strokes and shapes by (dx, dy) document units, as one undo step. */
  moveItems(strokeIds: ReadonlySet<string>, shapeIds: ReadonlySet<string>, dx: number, dy: number): void {
    if (this.readOnly || (!dx && !dy)) return;
    const op: Extract<InkOp, { type: "move" }> = { type: "move", strokeIds: [...strokeIds], shapeIds: [...shapeIds], dx, dy };
    if (!this.translate(op, 1)) return;
    this.record(op);
  }

  private translate(op: Extract<InkOp, { type: "move" }>, sign: 1 | -1): boolean {
    const strokes = new Set(op.strokeIds), shapes = new Set(op.shapeIds);
    const dx = op.dx * sign, dy = op.dy * sign;
    let moved = false;
    this.strokes = this.strokes.map((s) => {
      if (!strokes.has(s.id)) return s;
      moved = true;
      return { ...s, points: s.points.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)] as InkStroke["points"][number]) };
    });
    this.shapes = this.shapes.map((shape) => {
      if (!shapes.has(shape.id)) return shape;
      moved = true;
      return { ...shape, start: [shape.start[0] + dx, shape.start[1] + dy], end: [shape.end[0] + dx, shape.end[1] + dy] };
    });
    return moved;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): boolean {
    if (this.readOnly) return false;
    const op = this.undoStack.pop();
    if (!op) return false;
    switch (op.type) {
      case "add": {
        const idx = this.strokes.findIndex((s) => s.id === op.stroke.id);
        if (idx >= 0) this.strokes.splice(idx, 1);
        delete this.erased[op.stroke.id];
        break;
      }
      case "addShape":
        this.shapes = this.shapes.filter((shape) => shape.id !== op.shape.id);
        break;
      case "snap":
        // Back to what was drawn; that stroke is then an ordinary one (one more
        // undo removes it).
        this.shapes = this.shapes.filter((shape) => shape.id !== op.shape.id);
        this.strokes.push(op.stroke);
        this.undoStack.push({ type: "add", stroke: op.stroke });
        break;
      case "erase":
        this.restoreIntervals(op.before);
        this.shapes.push(...op.shapes);
        break;
      case "move":
        this.translate(op, -1);
        break;
    }
    this.redoStack.push(op);
    return true;
  }

  redo(): boolean {
    if (this.readOnly) return false;
    const op = this.redoStack.pop();
    if (!op) return false;
    switch (op.type) {
      case "add":
        this.strokes.push(op.stroke);
        break;
      case "addShape":
        this.shapes.push(op.shape);
        break;
      case "snap": {
        // The stroke undo handed back is replaced by the shape again.
        const top = this.undoStack[this.undoStack.length - 1];
        if (top?.type === "add" && top.stroke.id === op.stroke.id) this.undoStack.pop();
        this.strokes = this.strokes.filter((s) => s.id !== op.stroke.id);
        this.shapes.push(op.shape);
        break;
      }
      case "erase": {
        this.restoreIntervals(op.after);
        const gone = new Set(op.shapes.map((shape) => shape.id));
        this.shapes = this.shapes.filter((shape) => !gone.has(shape.id));
        break;
      }
      case "move":
        this.translate(op, 1);
        break;
    }
    this.undoStack.push(op);
    return true;
  }

  private restoreIntervals(snapshot: ErasedIntervals): void {
    for (const [id, intervals] of Object.entries(snapshot)) {
      if (intervals.length === 0) delete this.erased[id];
      else this.erased[id] = cloneIntervals(intervals);
    }
  }

  /** Lowest page height that contains all ink (plus margin), never below min. */
  contentHeight(minHeight: number, margin: number): number {
    let maxY = 0;
    for (const s of this.strokes) {
      for (const p of s.points) {
        if (p[1] > maxY) maxY = p[1];
      }
    }
    for (const shape of this.shapes) maxY = Math.max(maxY, shapeMaxY(shape));
    return Math.max(minHeight, Math.ceil(maxY + margin));
  }

  serialize(): InkDocument {
    const erased: ErasedIntervals = {};
    for (const [id, intervals] of Object.entries(this.erased)) {
      if (intervals.length > 0) erased[id] = cloneIntervals(intervals);
    }
    return {
      ...structuredClone(this.docExtras),
      version: 1,
      strokes: this.strokes.map(cloneStroke),
      erased,
      page: { ...structuredClone(this.pageExtras), width: this.pageWidth, ...(this.background ? { background: this.background } : {}) },
      ...(this.hadShapes || this.shapes.length > 0 ? { shapes: structuredClone(this.shapes) } : {}),
    };
  }

  /** Replace state from a serialized document. Clears the undo history —
   *  cross-session undo is the host app's event restore, not this stack. */
  load(doc: InkDocument | null | undefined): void {
    const d = doc && typeof doc === "object" && Array.isArray(doc.strokes) ? doc : emptyInkDocument();
    this.strokes = d.strokes.map(cloneStroke);
    this.erased = {};
    for (const [id, intervals] of Object.entries(d.erased ?? {})) {
      if (Array.isArray(intervals) && intervals.length > 0) {
        this.erased[id] = mergeIntervals(intervals as EraseInterval[]);
      }
    }
    this.pageWidth = d.page?.width || INK_DEFAULT_PAGE_WIDTH;
    this.background = d.page?.background;
    this.hadShapes = Array.isArray(d.shapes);
    this.shapes = this.hadShapes ? structuredClone(d.shapes!) : [];
    this.docExtras = omit(d, MANAGED_DOC_KEYS);
    this.pageExtras = d.page && typeof d.page === "object" ? omit(d.page, MANAGED_PAGE_KEYS) : {};
    this.readOnly = isInkReadOnly(d);
    this.undoStack = [];
    this.redoStack = [];
  }
}

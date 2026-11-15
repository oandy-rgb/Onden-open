import { useCallback, useEffect, useState } from "react";
import { INK_SIZES } from "../lib/inkSizes";
import type { InkActiveTool, InkEngine, InkShapeFill, InkShapeKind } from "../lib/ink";
import { DEFAULT_AUTO_SHAPE, DEFAULT_SHAPE_FILL, DEFAULT_SHAPE_KIND, inkAutoShapePref, inkShapeFillPref, inkShapeKindPref } from "../lib/inkPrefs";

/** What every ink host keeps about the pen: the tool in hand (`tool`, the only
 *  place an `InkActiveTool` is held as state; hosts with extra tools keep their
 *  own superset), its colour and thickness (this view only), the shape the shape button last drew and whether holding the pen
 *  still makes a shape, and whether shapes are filled (all follow the account, lib/inkPrefs). `toolbar` is
 *  what InkToolbar takes for them. */
export function useInkPen(initial: { color: string; sizeId: string }) {
  const [tool, setTool] = useState<InkActiveTool>("pen");
  const [color, setColor] = useState(initial.color);
  const [sizeId, setSizeId] = useState(initial.sizeId);
  const shapePref = inkShapeKindPref.useValue();
  const autoPref = inkAutoShapePref.useValue();
  const fillPref = inkShapeFillPref.useValue();
  const shapeKind = shapePref.value ?? DEFAULT_SHAPE_KIND;
  const autoShape = autoPref.value ?? DEFAULT_AUTO_SHAPE;
  const shapeFill = fillPref.value ?? DEFAULT_SHAPE_FILL;
  const size = (INK_SIZES.find((s) => s.id === sizeId) ?? INK_SIZES[1]!).value;
  const saveShapeKind = shapePref.save;
  const setShapeKind = useCallback((kind: InkShapeKind) => { void saveShapeKind(kind); }, [saveShapeKind]);
  const saveShapeFill = fillPref.save;
  const setShapeFill = useCallback((fill: InkShapeFill) => { void saveShapeFill(fill); }, [saveShapeFill]);
  return {
    tool, setTool, color, size, shapeKind, autoShape, shapeFill,
    toolbar: {
      color,
      onColorChange: setColor,
      sizeId,
      onSizeChange: (s: { id: string; value: number }) => setSizeId(s.id),
      shape: { kind: shapeKind, onKindChange: setShapeKind, fill: shapeFill, onFillChange: setShapeFill },
    },
  };
}

/** Keep a host's engine on the pen the person chose. `ready` is false while
 *  the engine is still being built. */
export function useApplyPen(
  getEngine: () => InkEngine | null,
  pen: Pick<ReturnType<typeof useInkPen>, "color" | "size" | "shapeKind" | "shapeFill" | "autoShape">,
  ready = true,
): void {
  useEffect(() => {
    const engine = getEngine();
    if (!engine || !ready) return;
    engine.setColor(pen.color);
    engine.setSize(pen.size);
    engine.setShapeKind(pen.shapeKind);
    engine.setShapeFill(pen.shapeFill);
    engine.setAutoShape(pen.autoShape);
    // getEngine reads a ref; only the pen's values change what is applied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pen.color, pen.size, pen.shapeKind, pen.shapeFill, pen.autoShape, ready]);
}

/** The toolbar props that come from the host's engine: undo / redo (the
 *  engine's own history). The device's input settings are not on the toolbar —
 *  the ⋯ menu (components/PageMoreMenu) has the finger switch. */
export function engineToolbarProps(
  getEngine: () => InkEngine | null,
  history: { canUndo: boolean; canRedo: boolean },
) {
  return {
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    onUndo: () => getEngine()?.undo(),
    onRedo: () => getEngine()?.redo(),
  };
}

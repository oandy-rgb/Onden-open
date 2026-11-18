// Public surface of the host-agnostic ink engine.
//
//   engine    — InkEngine: canvases + pointer pipeline + undo + onChange
//   penShortcut — pen shortcut detection (S Pen side button, native shell; pen ↔ eraser), pure
//   inputPolicy — who draws / pans / zooms (pen vs finger vs mouse), pure
//   touchSplit — pen / palm / pinch vs the browser's native scroll (DOM)
//   pageSession / pageSurfaceEnv — the page book's engines: their edits, undo order, near-screen, pointer end
//   pageZoom  — zoom limits, the canvas pixel cap, a growing page's layout math (engine tests)
//   model     — InkModel: pure document state (DOM-free, unit-tested)
//   outline   — stroke → polygon via vendored perfect-freehand
//   erase     — scribble-eraser interval geometry
//   color     — dark-mode HSL lightness inversion
//   palette   — the ink colours: palette, quick colours, recent / custom (pure)
//   shapes / recognize — a stored shape as strokes; "hold still" shape recognition (pure)
//
//   committed — ICommittedRenderer seam: Canvas 2D, tiled
//
// Hosts: InkNodeView (handwriting note, T1) and CanvasInkLayer (knowledge
// canvas) — both reuse InkEngine; the canvas host injects a React Flow
// InkTransform (flowTransform) and a tiled committed renderer.

export { usePenShortcutTool } from "./usePenShortcutTool";
export { InkEngine, type InkEngineOptions, type InkGestureHost } from "./engine";
export { registerInkEdit } from "./boardHistory";
export type { InkSelection } from "./select";
export { extractInkClip, inkClipBounds, isEmptyInkClip, placeInkClip, type InkClip } from "./clip";
export {
  InkInputPolicy,
  fingerDraws,
  type InkInputAction,
  type InkPointerSample,
} from "./inputPolicy";
export { InkPageSession, pageSignature, type PageSurfaceSession, type WritePage } from "./pageSession";
export { observeSize, onPointerEnd, pixelRatio, useNearScreen } from "./pageSurfaceEnv";
export { startGlide, flingVelocity, pushFlingSample, type FlingSample } from "./glide";
export { deviceHasTouch, pressedOnScreen } from "./touch";
export { installTouchSplit, type PinchHost } from "./touchSplit";
export { PAGE_ZOOM_MAX, PAGE_ZOOM_MIN, cappedPixelRatio, pageInkTransform, type PageCamera } from "./pageZoom";
export {
  Canvas2dCommittedRenderer,
  createCommittedRenderer,
  type CommittedView,
  type ICommittedRenderer,
} from "./committed";
export { flowInkTransform, type FlowViewportLike } from "./flowTransform";
export { InkModel } from "./model";
export {
  emptyInkDocument,
  INK_DEFAULT_PAGE_WIDTH,
  type EraseInterval,
  type ErasedIntervals,
  type InkActiveTool,
  type InkDocument,
  type InkPoint,
  type InkShape,
  type InkShapeFill,
  type InkShapeKind,
  type InkStroke,
  type InkToolId,
  type InkTransform,
} from "./types";
export { strokeOutline, strokeOptionsFor, shouldSimulatePressure, hasRealPressure, easeOutSine, outlineToPath } from "./outline";
export { HIGHLIGHTER_ALPHA } from "./renderer";
export {
  DEFAULT_PALETTE_STATE, DEFAULT_QUICK_COLORS, INK_PALETTE, QUICK_SLOTS,
  normalizeHex, paletteLabel, parsePalette, withCustomColor, withQuickColor, withRecentColor,
  type InkPaletteState,
} from "./palette";
export {
  MAX_PRESETS, canAddPreset, parsePresets, presetMatches, withPreset, withPresetName, withoutPreset,
  type InkPreset, type InkPresetList, type PresetTool,
} from "./presets";
export { hexToHsv, hsvToHex, type Hsv } from "./hsv";
export { PICK_REACH_PX, colorInDrawing, pickColorAt, registerColorSource, type ColorSource } from "./colorPick";
export { recognizeShape, type RecognizedShape } from "./recognize";
export { shapeStrokes } from "./shapes";
export { inkThumbnailSvg } from "./thumbnail";
export { describeInkDiff, diffInk, isEmptyInkDiff, type InkDiff } from "./diff";
export { mergeIntervals, eraseStrokeWithTrail, visibleRuns, isFullyErased } from "./erase";
export { clamp01, invertLightness, themedStrokeColor } from "./color";
export { inkReadOnlyMessage, isInkReadOnly, loadInkAttributes, notifyInkReadOnly } from "./store";
export { InkSaver, useInkSurfaceSaver } from "./surfaceSaver";

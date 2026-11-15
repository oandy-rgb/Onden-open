// Stroke → outline polygon, via the vendored perfect-freehand core.
//
// Parameters are the production-proven tldraw/Excalidraw set, pinned by the
// handwriting spec:
//   - simulatePressure = (pointerType !== 'pen') — i.e. simulate exactly when
//     the points carry no real pressure samples.
//   - mouse/touch: thinning 0.5, streamline 0.62, smoothing 0.62, easeOutSine
//   - pen (real pressure): thinning 0.62, streamline 0.62, smoothing 0.62,
//     size = 1 + size * 1.2, identity easing
// The highlighter is a fixed-width band (thinning 0) drawn translucent by
// the renderer.

// The outline geometry is shared with every static rendering of a drawing
// (@onden/markdown inkSvg.ts: review cards, `![[drawing]]` embeds, the
// published site), so the picture matches what the editor draws.
export { easeOutSine, hasRealPressure, outlineToPath, strokeOptionsFor, strokeOutline, type OutlineParams } from "@onden/markdown/ink";

/** Map a live pointerType to whether pressure must be simulated. */
export function shouldSimulatePressure(pointerType: string): boolean {
  return pointerType !== "pen";
}

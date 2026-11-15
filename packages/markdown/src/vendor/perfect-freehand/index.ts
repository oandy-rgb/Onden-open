/*
 * Vendored from perfect-freehand (https://github.com/steveruizok/perfect-freehand)
 * Upstream: perfect-freehand v1.2.3, commit 176e00f2399f4969e1b0965c5921d96a3e50ce9f.
 * MIT License — Copyright (c) 2021 Stephen Ruiz Ltd. See LICENSE in this folder.
 *
 * Re-exports the subset of the library the ink engine consumes. Vendored
 * (rather than npm-installed) so the worktree builds against the local
 * clone surveyed for the handwriting spec, with provenance pinned.
 */
export { getStroke } from "./getStroke.js";
export { getStrokePoints } from "./getStrokePoints.js";
export { getStrokeOutlinePoints } from "./getStrokeOutlinePoints.js";
export type { StrokeOptions, StrokePoint, Vec2 } from "./types.js";

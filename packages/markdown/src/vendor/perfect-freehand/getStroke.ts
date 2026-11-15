/*
 * Vendored from perfect-freehand (https://github.com/steveruizok/perfect-freehand)
 * Upstream: perfect-freehand v1.2.3, commit 176e00f2399f4969e1b0965c5921d96a3e50ce9f.
 * packages/perfect-freehand/src/getStroke.ts — copied verbatim, MIT License.
 *
 * MIT License
 *
 * Copyright (c) 2021 Stephen Ruiz Ltd
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { StrokeOptions, Vec2 } from './types.js'
import { getStrokeOutlinePoints } from './getStrokeOutlinePoints.js'
import { getStrokePoints } from './getStrokePoints.js'

/**
 * ## getStroke
 * @description Get an array of points describing a polygon that surrounds the input points.
 * @param points An array of points (as `[x, y, pressure]` or `{x, y, pressure}`). Pressure is optional in both cases.
 * @param options (optional) An object with options.
 * @param options.size	The base size (diameter) of the stroke.
 * @param options.thinning The effect of pressure on the stroke's size.
 * @param options.smoothing	How much to soften the stroke's edges.
 * @param options.easing	An easing function to apply to each point's pressure.
 * @param options.simulatePressure Whether to simulate pressure based on velocity.
 * @param options.start Cap, taper and easing for the start of the line.
 * @param options.end Cap, taper and easing for the end of the line.
 * @param options.last Whether to handle the points as a completed stroke.
 */

export function getStroke(
  points: (number[] | { x: number; y: number; pressure?: number })[],
  options: StrokeOptions = {} as StrokeOptions
): Vec2[] {
  return getStrokeOutlinePoints(getStrokePoints(points, options), options)
}

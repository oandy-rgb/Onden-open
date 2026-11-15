/*
 * Vendored from perfect-freehand (https://github.com/steveruizok/perfect-freehand)
 * Upstream: perfect-freehand v1.2.3, commit 176e00f2399f4969e1b0965c5921d96a3e50ce9f.
 * packages/perfect-freehand/src/simulatePressure.ts — copied verbatim, MIT License.
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

import { RATE_OF_PRESSURE_CHANGE } from './constants.js'

const { min } = Math

/**
 * Simulate pressure based on the distance between points and stroke size.
 * This creates a natural-looking pressure effect based on drawing velocity.
 *
 * @param prevPressure The previous pressure value
 * @param distance The distance from the previous point
 * @param size The base stroke size
 * @returns The simulated pressure value (0-1)
 * @internal
 */
export function simulatePressure(
  prevPressure: number,
  distance: number,
  size: number
): number {
  // Speed of change - how fast should the pressure be changing?
  const sp = min(1, distance / size)
  // Rate of change - how much of a change is there?
  const rp = min(1, 1 - sp)
  // Accelerate the pressure
  return min(
    1,
    prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE)
  )
}

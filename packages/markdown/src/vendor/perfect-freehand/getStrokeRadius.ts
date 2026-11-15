/*
 * Vendored from perfect-freehand (https://github.com/steveruizok/perfect-freehand)
 * Upstream: perfect-freehand v1.2.3, commit 176e00f2399f4969e1b0965c5921d96a3e50ce9f.
 * packages/perfect-freehand/src/getStrokeRadius.ts — copied verbatim, MIT License.
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

/**
 * Compute a radius based on the pressure.
 * @param size
 * @param thinning
 * @param pressure
 * @param easing
 * @internal
 */
export function getStrokeRadius(
  size: number,
  thinning: number,
  pressure: number,
  easing: (t: number) => number = (t) => t
) {
  return size * easing(0.5 - thinning * (0.5 - pressure))
}

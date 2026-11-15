/*
 * Vendored from perfect-freehand (https://github.com/steveruizok/perfect-freehand)
 * Upstream: perfect-freehand v1.2.3, commit 176e00f2399f4969e1b0965c5921d96a3e50ce9f.
 * packages/perfect-freehand/src/constants.ts — copied verbatim, MIT License.
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
 * Constants used throughout the stroke generation algorithm.
 * @internal
 */

const { PI } = Math

/**
 * Rate of change for simulated pressure.
 * Controls how quickly pressure changes based on drawing velocity.
 * Higher values make pressure more responsive to speed changes.
 */
export const RATE_OF_PRESSURE_CHANGE = 0.275

/**
 * PI with a tiny offset to fix browser rendering artifacts.
 * Some browsers render strokes incorrectly when using exact PI.
 */
export const FIXED_PI = PI + 0.0001

/**
 * Number of segments for rounded start caps.
 */
export const START_CAP_SEGMENTS = 13

/**
 * Number of segments for rounded end caps.
 * Higher than start caps for smoother appearance at stroke endings.
 */
export const END_CAP_SEGMENTS = 29

/**
 * Number of segments for sharp corner caps.
 */
export const CORNER_CAP_SEGMENTS = 13

/**
 * Pixels to skip at the end of a stroke to reduce noise.
 */
export const END_NOISE_THRESHOLD = 3

/**
 * Minimum interpolation factor for streamline.
 * Used when streamline is at maximum (1.0).
 */
export const MIN_STREAMLINE_T = 0.15

/**
 * Range for interpolation factor calculation.
 * Added to MIN_STREAMLINE_T based on (1 - streamline).
 */
export const STREAMLINE_T_RANGE = 0.85

/**
 * Minimum stroke radius to prevent invisible strokes.
 */
export const MIN_RADIUS = 0.01

/**
 * Default pressure for the first point of a stroke.
 * Lower than subsequent points to prevent fat starts,
 * since drawn lines almost always start slow.
 */
export const DEFAULT_FIRST_PRESSURE = 0.25

/**
 * Default pressure for subsequent points when no pressure is provided.
 */
export const DEFAULT_PRESSURE = 0.5

/**
 * Unit offset vector used as placeholder for initial vector
 * and for creating a second point when only one point is provided.
 */
export const UNIT_OFFSET: [number, number] = [1, 1]

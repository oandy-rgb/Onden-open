// A colour as hue / saturation / value (what a palette square and hue bar
// show), and back to the `#rrggbb` the strokes store. Pure.

import { normalizeHex } from "./palette";

export interface Hsv {
  /** 0–360 (360 is the same red as 0). */
  h: number;
  /** 0–1. */
  s: number;
  /** 0–1 (brightness). */
  v: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function hexToHsv(hex: string): Hsv | null {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const r = parseInt(norm.slice(1, 3), 16) / 255, g = parseInt(norm.slice(3, 5), 16) / 255, b = parseInt(norm.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = (((h % 360) + 360) % 360) / 60;
  const sat = clamp(s, 0, 1), val = clamp(v, 0, 1);
  const f = (n: number) => {
    const k = (n + hue) % 6;
    return val - val * sat * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(5))}${hex(f(3))}${hex(f(1))}`;
}

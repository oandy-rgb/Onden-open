// Dark-mode color mapping (Saber's model): invert HSL lightness only,
// preserving hue and saturation, so oxblood stays oxblood-ish and near-black
// ink becomes near-white ink. Stored stroke colors stay canonical
// (light-theme values); inversion is render-time only.

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    const short = /^#?([0-9a-f]{3})$/i.exec(hex.trim());
    if (!short) return null;
    const s = short[1];
    return [
      parseInt(s[0] + s[0], 16),
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
    ];
  }
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/** Invert only the HSL lightness of a hex color (H and S preserved).
 *  Non-hex inputs are returned unchanged (we never store those, but the
 *  helper shouldn't throw on a hand-edited document). */
export function invertLightness(color: string): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const [r, g, b] = hslToRgb(h, s, clamp01(1 - l));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Render-time color for a stroke: canonical in light theme, lightness-
 *  inverted in dark theme. */
export function themedStrokeColor(color: string, dark: boolean): string {
  return dark ? invertLightness(color) : color;
}

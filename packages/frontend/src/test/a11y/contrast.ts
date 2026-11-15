// WCAG contrast arithmetic and a reader for the colour tokens in styles/tokens.css.
import { readSource } from "./sourceFiles";

export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

const channel = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** color-mix(in srgb, a p%, b): CSS interpolates the gamma-encoded channels. */
export function mix(a: Rgb, percent: number, b: Rgb): Rgb {
  return a.map((v, i) => Math.round((v * percent + b[i] * (100 - percent)) / 100)) as unknown as Rgb;
}

export type Theme = "light" | "dark";
export type Palette = Record<string, Rgb>;

/** The --ac-* hex tokens of one theme block of tokens.css (the block that defines --ac-bg for it). */
export function readPalette(theme: Theme): Palette {
  const css = readSource("styles/tokens.css");
  const selector = theme === "light" ? /:root,\s*\[data-theme="light"\]\s*\{/ : /\[data-theme="dark"\]\s*\{/;
  const palette: Palette = {};
  for (const block of css.matchAll(new RegExp(`${selector.source}([^}]*)\\}`, "g"))) {
    for (const d of block[1].matchAll(/--ac-([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) palette[d[1]] = parseHex(d[2]);
  }
  return palette;
}

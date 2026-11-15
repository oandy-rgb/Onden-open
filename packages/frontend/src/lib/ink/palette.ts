// The ink colours: the full palette, the five quick colours the toolbar shows,
// and the colours a person added or used lately. Pure — the account pref that
// keeps the person's part is lib/inkPrefs.ts.
//
// Colours are stored canonical (as for light theme); dark mode inverts the
// lightness at render time (color.ts), so the light pastels below also read as
// soft dark tones on a dark page.

export interface PaletteColor {
  value: string;
  /** English source name, translated where shown. */
  label: string;
}

/** About twenty colours in four rows: darks and neutrals, warm, cool, and
 *  light ones that suit the highlighter. */
export const INK_PALETTE: readonly PaletteColor[] = [
  { value: "#15130d", label: "Ink" },
  { value: "#4a4a48", label: "Dark gray" },
  { value: "#8a8a85", label: "Gray" },
  { value: "#7a2e33", label: "Oxblood" },
  { value: "#c43c3c", label: "Red" },
  { value: "#d9732a", label: "Orange" },
  { value: "#c2871d", label: "Amber" },
  { value: "#e0b81a", label: "Yellow" },
  { value: "#6a9a2f", label: "Grass" },
  { value: "#2f7d4f", label: "Green" },
  { value: "#1f8a8a", label: "Teal" },
  { value: "#3a8fd0", label: "Sky" },
  { value: "#315f8f", label: "Blue" },
  { value: "#1f3a6e", label: "Navy" },
  { value: "#4c4a9e", label: "Indigo" },
  { value: "#fff176", label: "Light yellow" },
  { value: "#a5e8a0", label: "Light green" },
  { value: "#9fd8ff", label: "Light blue" },
  { value: "#ffb3d1", label: "Light pink" },
  { value: "#d6b8ff", label: "Light purple" },
];

/** What the toolbar shows until the person changes it (the colours it always had). */
export const DEFAULT_QUICK_COLORS: readonly string[] = ["#15130d", "#7a2e33", "#315f8f", "#c2871d", "#c43c3c"];

export const QUICK_SLOTS = 5;
export const MAX_RECENT = 8;
export const MAX_CUSTOM = 12;

export interface InkPaletteState {
  /** Exactly QUICK_SLOTS colours, in toolbar order. */
  quick: string[];
  /** Colours used lately from the full palette, newest first. */
  recent: string[];
  /** Colours the person made (a colour code or the wheel), newest first. */
  custom: string[];
}

export const DEFAULT_PALETTE_STATE: InkPaletteState = { quick: [...DEFAULT_QUICK_COLORS], recent: [], custom: [] };

/** `#rgb` or `#rrggbb` (with or without the #, any case) → `#rrggbb`; else null. */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1]!.toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function listOf(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const hex = normalizeHex(entry);
    if (hex && !out.some((c) => sameColor(c, hex)) && out.length < max) out.push(hex);
  }
  return out;
}

/** The stored value, made safe: bad colours dropped, lists bounded, quick filled up to five. */
export function parsePalette(value: unknown): InkPaletteState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const quick = listOf(v.quick, QUICK_SLOTS);
  for (const fallback of DEFAULT_QUICK_COLORS) {
    if (quick.length >= QUICK_SLOTS) break;
    if (!quick.some((c) => sameColor(c, fallback))) quick.push(fallback);
  }
  return { quick, recent: listOf(v.recent, MAX_RECENT), custom: listOf(v.custom, MAX_CUSTOM) };
}

/** `color` was picked in the full palette: it moves to the front of the recent colours. */
export function withRecentColor(state: InkPaletteState, color: string): InkPaletteState {
  const hex = normalizeHex(color);
  if (!hex) return state;
  return { ...state, recent: [hex, ...state.recent.filter((c) => !sameColor(c, hex))].slice(0, MAX_RECENT) };
}

/** A colour the person made: kept (newest first) unless the palette already has it. */
export function withCustomColor(state: InkPaletteState, color: string): InkPaletteState {
  const hex = normalizeHex(color);
  if (!hex || INK_PALETTE.some((c) => sameColor(c.value, hex))) return state;
  return { ...state, custom: [hex, ...state.custom.filter((c) => !sameColor(c, hex))].slice(0, MAX_CUSTOM) };
}

/** `color` takes quick slot `slot` (its old owner elsewhere in the row moves
 *  into the slot being replaced, so the row never shows one colour twice). */
export function withQuickColor(state: InkPaletteState, slot: number, color: string): InkPaletteState {
  const hex = normalizeHex(color);
  if (!hex || slot < 0 || slot >= QUICK_SLOTS) return state;
  const quick = [...state.quick];
  const was = quick.findIndex((c) => sameColor(c, hex));
  if (was >= 0) quick[was] = quick[slot]!;
  quick[slot] = hex;
  return { ...state, quick };
}

/** The name of a palette colour, or null for one the person made. */
export function paletteLabel(color: string): string | null {
  return INK_PALETTE.find((c) => sameColor(c.value, color))?.label ?? null;
}

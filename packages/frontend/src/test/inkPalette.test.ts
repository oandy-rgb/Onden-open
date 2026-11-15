import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUICK_COLORS, INK_PALETTE, MAX_CUSTOM, MAX_RECENT, QUICK_SLOTS, DEFAULT_PALETTE_STATE,
  normalizeHex, paletteLabel, parsePalette, withCustomColor, withQuickColor, withRecentColor,
} from "../lib/ink/palette";
import { invertLightness, themedStrokeColor } from "../lib/ink";

const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, "0")}`);

describe("the palette", () => {
  it("has about twenty colours, with darks, mid tones and light ones for the highlighter", () => {
    expect(INK_PALETTE.length).toBe(20);
    expect(new Set(INK_PALETTE.map((c) => c.value)).size).toBe(20);
    for (const c of INK_PALETTE) expect(normalizeHex(c.value)).toBe(c.value);
    const lightness = (c: string) => { const n = parseInt(c.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
    expect(INK_PALETTE.filter((c) => lightness(c.value) > 0.75).length).toBeGreaterThanOrEqual(5);
    expect(INK_PALETTE.filter((c) => lightness(c.value) < 0.3).length).toBeGreaterThanOrEqual(3);
  });

  it("the colours the toolbar always had are the default quick ones, in the palette", () => {
    expect(DEFAULT_QUICK_COLORS).toEqual(["#15130d", "#7a2e33", "#315f8f", "#c2871d", "#c43c3c"]);
    for (const c of DEFAULT_QUICK_COLORS) expect(paletteLabel(c)).not.toBeNull();
  });

  it("dark mode inverts a palette colour's lightness and keeps its hue (the existing rule)", () => {
    expect(themedStrokeColor("#15130d", false)).toBe("#15130d");
    expect(themedStrokeColor("#15130d", true)).not.toBe("#15130d");
    // A pastel marker colour turns into a dark tone, still the same hue family.
    expect(invertLightness("#fff176")).not.toBe("#fff176");
  });
});

describe("normalizeHex", () => {
  it("reads #rgb, #rrggbb and the same without #, in any case", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("c43c3c")).toBe("#c43c3c");
    expect(normalizeHex("  #C43C3C ")).toBe("#c43c3c");
  });
  it("refuses everything else", () => {
    for (const bad of ["", "#12", "#12345", "#1234567", "red", "rgb(1,2,3)", "#ggg", null, 5, undefined]) expect(normalizeHex(bad)).toBeNull();
  });
  it("is idempotent", () => {
    fc.assert(fc.property(hex, (c) => { expect(normalizeHex(normalizeHex(c)!)).toBe(normalizeHex(c)); }));
  });
});

describe("parsePalette (what the account holds)", () => {
  it("takes nothing but an object", () => {
    for (const bad of [null, undefined, 3, "x", [], true]) expect(parsePalette(bad)).toBeNull();
  });

  it("always yields five distinct quick colours, bounded lists, valid colours", () => {
    fc.assert(fc.property(fc.record({
      quick: fc.array(fc.oneof(hex, fc.string()), { maxLength: 9 }),
      recent: fc.array(fc.oneof(hex, fc.string()), { maxLength: 30 }),
      custom: fc.array(fc.oneof(hex, fc.string()), { maxLength: 30 }),
    }), (raw) => {
      const p = parsePalette(raw)!;
      expect(p.quick).toHaveLength(QUICK_SLOTS);
      expect(new Set(p.quick).size).toBe(QUICK_SLOTS);
      expect(p.recent.length).toBeLessThanOrEqual(MAX_RECENT);
      expect(p.custom.length).toBeLessThanOrEqual(MAX_CUSTOM);
      for (const c of [...p.quick, ...p.recent, ...p.custom]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      // idempotent: what was cleaned reads back the same
      expect(parsePalette(p)).toEqual(p);
    }));
  });

  it("an empty object is the defaults", () => {
    expect(parsePalette({})).toEqual(DEFAULT_PALETTE_STATE);
  });
});

describe("recent, custom and quick colours", () => {
  it("a used colour goes to the front once, and the list stays bounded", () => {
    fc.assert(fc.property(fc.array(hex, { maxLength: 40 }), (colors) => {
      let state = DEFAULT_PALETTE_STATE;
      for (const c of colors) state = withRecentColor(state, c);
      expect(state.recent.length).toBeLessThanOrEqual(MAX_RECENT);
      expect(new Set(state.recent).size).toBe(state.recent.length);
      if (colors.length) expect(state.recent[0]).toBe(colors[colors.length - 1]);
    }));
  });

  it("a colour the person made is kept unless the palette has it", () => {
    expect(withCustomColor(DEFAULT_PALETTE_STATE, "#c43c3c")).toBe(DEFAULT_PALETTE_STATE);
    expect(withCustomColor(DEFAULT_PALETTE_STATE, "#123456").custom).toEqual(["#123456"]);
    expect(withCustomColor(DEFAULT_PALETTE_STATE, "nonsense")).toBe(DEFAULT_PALETTE_STATE);
  });

  it("replacing a quick colour keeps five distinct ones, and puts the colour where asked", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), fc.oneof(hex, fc.constantFrom(...INK_PALETTE.map((c) => c.value))), (slot, color) => {
      const next = withQuickColor(DEFAULT_PALETTE_STATE, slot, color);
      expect(next.quick).toHaveLength(QUICK_SLOTS);
      expect(new Set(next.quick).size).toBe(QUICK_SLOTS);
      expect(next.quick[slot]).toBe(color);
    }));
  });

  it("a slot out of range changes nothing", () => {
    expect(withQuickColor(DEFAULT_PALETTE_STATE, 5, "#123456")).toBe(DEFAULT_PALETTE_STATE);
    expect(withQuickColor(DEFAULT_PALETTE_STATE, -1, "#123456")).toBe(DEFAULT_PALETTE_STATE);
  });
});

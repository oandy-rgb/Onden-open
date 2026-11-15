// What the person chose for ink, kept per account so it is the same on every
// device (lib/accountPrefStore): the quick colours and the colours they made or
// used lately, the shape the shape button last drew, whether new shapes are filled, the pen
// presets, and whether a pen held still turns a stroke into a shape. None of it changes a drawing.

import { INK_SHAPE_KINDS } from "@onden/markdown/contract";
import type { InkShapeFill, InkShapeKind } from "@onden/markdown/ink";
import { createAccountPref } from "./accountPrefStore";
import { DEFAULT_PALETTE_STATE, parsePalette, parsePresets, type InkPaletteState, type InkPresetList } from "./ink";
import { PREFS } from "./prefs";

export const inkPalettePref = createAccountPref<InkPaletteState>({
  serverKey: "inkPalette",
  follows: "account", // their colours: a taste (pens exist on phone and tablet too)
  copy: PREFS.inkPaletteCopy,
  parse: parsePalette,
});

export function parseShapeKind(value: unknown): InkShapeKind | null {
  return typeof value === "string" && (INK_SHAPE_KINDS as readonly string[]).includes(value) ? (value as InkShapeKind) : null;
}

export const inkShapeKindPref = createAccountPref<InkShapeKind>({
  serverKey: "inkShape",
  follows: "account", // the shape the shape button last drew: a habit
  copy: PREFS.inkShapeCopy,
  parse: parseShapeKind,
});

export const inkAutoShapePref = createAccountPref<boolean>({
  serverKey: "inkAutoShape",
  follows: "account", // auto-fix shapes on pause: a habit
  copy: PREFS.inkAutoShapeCopy,
  parse: (value) => (typeof value === "boolean" ? value : null),
});

export const inkShapeFillPref = createAccountPref<InkShapeFill>({
  serverKey: "inkShapeFill",
  follows: "account", // whether new shapes are filled: a habit
  copy: PREFS.inkShapeFillCopy,
  parse: (value) => (value === "none" || value === "solid" ? value : null),
});

/** The pen presets the person saved (tool + colour + thickness, at most six). */
export const inkPresetsPref = createAccountPref<InkPresetList>({
  serverKey: "inkPresets",
  follows: "account", // their saved pen presets: should follow them
  copy: PREFS.inkPresetsCopy,
  parse: parsePresets,
});

/** The shape the button starts on, and whether holding the pen still makes a
 *  shape, until the person says otherwise. */
export const DEFAULT_SHAPE_KIND: InkShapeKind = "rectangle";
export const DEFAULT_AUTO_SHAPE = true;
export const DEFAULT_SHAPE_FILL: InkShapeFill = "none";

export { DEFAULT_PALETTE_STATE };

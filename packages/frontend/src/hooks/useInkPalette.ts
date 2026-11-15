import { useCallback } from "react";
import { inkPalettePref } from "../lib/inkPrefs";
import {
  DEFAULT_PALETTE_STATE, withCustomColor, withQuickColor, withRecentColor, type InkPaletteState,
} from "../lib/ink";

/** The person's quick colours and the colours they made or used lately (kept
 *  per account, lib/inkPrefs). Until a saved value arrives the defaults show. */
export function useInkPalette() {
  const { value, save } = inkPalettePref.useValue();
  const palette: InkPaletteState = value ?? DEFAULT_PALETTE_STATE;
  /** A colour of the full palette (or the lists) was used. */
  const noteUsed = useCallback((color: string) => { void save(withRecentColor(palette, color)); }, [palette, save]);
  /** A colour code or wheel colour was used: kept under My colors. */
  const addCustom = useCallback((color: string) => { void save(withCustomColor(palette, color)); }, [palette, save]);
  const setQuickSlot = useCallback((slot: number, color: string) => { void save(withQuickColor(palette, slot, color)); }, [palette, save]);
  return { palette, noteUsed, addCustom, setQuickSlot };
}

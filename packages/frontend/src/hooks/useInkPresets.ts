import { useCallback } from "react";
import { canAddPreset, withPreset, withPresetName, withoutPreset, type InkPreset, type InkPresetList } from "../lib/ink";
import { inkPresetsPref } from "../lib/inkPrefs";
import { randomUUID } from "../lib/uuid";

const NONE: InkPresetList = [];

/** The pen presets the person saved (kept per account, lib/inkPrefs): what is
 *  there, saving the pen as a new one, renaming, deleting. */
export function useInkPresets() {
  const { value, save } = inkPresetsPref.useValue();
  const presets: InkPresetList = value ?? NONE;
  const add = useCallback((pen: Omit<InkPreset, "id">): boolean => {
    if (!canAddPreset(presets)) return false;
    void save(withPreset(presets, { ...pen, id: randomUUID() }));
    return true;
  }, [presets, save]);
  const rename = useCallback((id: string, name: string) => { void save(withPresetName(presets, id, name)); }, [presets, save]);
  const remove = useCallback((id: string) => { void save(withoutPreset(presets, id)); }, [presets, save]);
  return { presets, add, rename, remove, full: !canAddPreset(presets) };
}

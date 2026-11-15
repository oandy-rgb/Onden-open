// A board's frames (sections) merged field by field. Pure: boardWrites.applyBoardChanges reads the stored list,
// merges the change here and writes it back under the workspace write lock.

import type { BoardSectionPatch } from "@onden/contract";
import type { BoardSection } from "./boardStore.js";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The stored frames after `upsert` and `remove`: a frame is patched field by field (a patch names only what
 *  it changed, so two devices editing different fields of one frame both keep their edit), the way a card is.
 *  A frame not stored yet is created only from a patch that carries its whole geometry; a patch for a frame
 *  that is gone is dropped, not revived without a size. A removal beats an upsert of the same id. */
export function mergeSections(stored: readonly BoardSection[], upsert: readonly BoardSectionPatch[], remove: readonly string[]): BoardSection[] {
  const gone = new Set(remove);
  const patches = new Map<string, BoardSectionPatch>();
  for (const patch of upsert) {
    const named = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    patches.set(patch.id, { ...patches.get(patch.id), ...named } as BoardSectionPatch);
  }
  const apply = (base: BoardSection | undefined, patch: BoardSectionPatch): BoardSection => {
    const { color, ...rest } = { ...base, ...patch } as BoardSection;
    return color === null || color === undefined ? rest as BoardSection : { ...rest, color };
  };
  const merged: BoardSection[] = [];
  for (const section of stored) {
    if (gone.has(section.id)) continue;
    const patch = patches.get(section.id);
    merged.push(patch ? apply(section, patch) : section);
    patches.delete(section.id);
  }
  for (const patch of patches.values()) {
    if (gone.has(patch.id) || !isNum(patch.x) || !isNum(patch.y) || !isNum(patch.width) || !isNum(patch.height)) continue;
    merged.push(apply(undefined, patch));
  }
  return merged;
}

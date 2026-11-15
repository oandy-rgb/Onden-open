// "Move this note to another space": the one flow behind the note menu's 移動到…,
// the space chip's dialog and the site's 「移到發布空間」 (docs/architecture/spaces.md:
// a move changes who can read the note). Callers show the audience change first
// (spaceApi.previewMove + MovePreviewSummary) and call this once the person confirms.
import { addToast } from "./appStore";
import { writeErrors } from "./data";
import { t, tn } from "./i18n";
import { loadedSpaces, refreshSpaces, spaceApi, spaceLabel, type MovePreviewNumericEpoch } from "./spaces";

export type MoveOutcome = {
  /** How many notes are in the new space now. */
  moved: number;
  /** Set when the move failed after the person confirmed `seen`: the audience may have
   *  changed (409), so this is a fresh look to confirm again. Null when that look failed too. */
  freshPreview?: MovePreviewNumericEpoch | null;
};

/** Moves `nodeIds` into `spaceId`, then refreshes the spaces and says so. Errors are reported
 *  here, and the first failure stops the rest. `seen` is the preview the person confirmed for a
 *  single note, so the server can refuse if the audience changed since; without it each note
 *  is previewed right before it moves (the audience epoch moves with every move). */
export async function moveToSpace(nodeIds: string | readonly string[], spaceId: string, seen?: MovePreviewNumericEpoch): Promise<MoveOutcome> {
  const ids = typeof nodeIds === "string" ? [nodeIds] : nodeIds;
  const known = loadedSpaces().find((space) => space.id === spaceId);
  const label = spaceLabel(known ?? (seen ? { ...seen.to, is_default: false } : { kind: "shared", is_default: false, name: t("Shared space") }));
  let moved = 0;
  let failed = false;
  try {
    for (const id of ids) {
      const look = seen && ids.length === 1 ? seen : await spaceApi.previewMove(id, spaceId);
      await spaceApi.move(id, spaceId, look.membership_epoch);
      moved += 1;
    }
  } catch (error) {
    failed = true;
    writeErrors.report(error, addToast);
  }
  if (moved > 0) {
    await refreshSpaces();
    addToast(tn("Moved to {space}", "Moved {n} notes to {space}", ids.length, { n: moved, space: label }));
  }
  if (!failed || !seen) return { moved };
  try { return { moved, freshPreview: await spaceApi.previewMove(ids[0]!, spaceId) }; }
  catch (error) { writeErrors.report(error, addToast); return { moved, freshPreview: null }; }
}

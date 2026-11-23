// A note's 「內容」 tab can be removed from its tab row (lib/viewTabs: a record of layout "content" says it is hidden)
// while its text stays the note's body, and moved off the front (the same record holds its place). Everything that changes or depends on that goes through here, and this file
// loads only when it is used (hooks/useWorkspaceFocus, components/viewTabs/useViewTabActions import it on demand;
// lib/offlineWarmup keeps it for offline). Writes queue offline like any view write, except making the record, which needs the server.

import { addToast, getNode } from "./appStore";
import { capabilitiesFor } from "./capabilities";
import { viewWriter, type ViewOwner } from "./data";
import { t } from "./i18n";
import { peekOwnerViews, reloadOwnerViews, type SavedView } from "./ownerViews";
import { loadedSpaces } from "./spaces";
import { dropPendingTextJump } from "./cursorHandoff";
import { contentTabIn, freeViewName, isTabHidden } from "./viewTabs";

type Confirm = (message: string, options?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>;

const NEEDS_CONNECTION = () => t("Removing the tab needs a connection.");

/** The note's 「內容」 tab shows when this resolves true: shown again, last among the tabs, when it was hidden. False when the
 *  note has no such record. The writer reports a refusal (and rethrows). */
export async function showContentTab(nodeId: string): Promise<boolean> {
  const owner = { kind: "node", id: nodeId } as const;
  await reloadOwnerViews(owner);
  const views = peekOwnerViews(owner);
  const record = contentTabIn(views);
  if (!record) return false;
  if (isTabHidden(record)) {
    const last = views.reduce((place, view) => (view === record ? place : Math.max(place, view.pin_order)), -1) + 1;
    await viewWriter.update(owner, record.id, { layout_config_patch: { hidden: null }, pin_order: last });
    await reloadOwnerViews(owner);
  }
  toldAbout.delete(nodeId);
  return true;
}

/** Remove the 「內容」 tab from the row, after asking once. False when nothing was changed: the person declined, or the
 *  first removal (it makes the record) has no connection to make it with. `afterConfirm` runs once the person said yes, before the write. */
export async function hideContentTab(args: {
  owner: ViewOwner; record: SavedView | null; takenNames: readonly string[]; pinOrder: number; online: boolean; confirm: Confirm; afterConfirm?: () => void;
}): Promise<boolean> {
  const { owner, record } = args;
  if (!record && !args.online) { addToast(NEEDS_CONNECTION(), "info"); return false; }
  const ok = await args.confirm(
    t("Remove the “{name}” tab? The text is still there; only the tab is hidden. Search, publishing and export still include it.", { name: t("Content") }),
    { confirmLabel: t("Remove"), danger: true },
  );
  if (!ok) return false;
  args.afterConfirm?.();
  if (record) await viewWriter.update(owner, record.id, { layout_config_patch: { hidden: true } });
  // Always stored under the English word, which the tab row shows in the person's own language (like the whiteboard's record).
  else await viewWriter.create(owner, { name: freeViewName("Content", args.takenNames), layout: "content", visible_fields: [], layout_config: { hidden: true }, pin_order: args.pinOrder }, NEEDS_CONNECTION());
  return true;
}

const MOVE_NEEDS_CONNECTION = () => t("Moving the Content tab the first time needs a connection.");

/** 「內容」 leaves the front of the row for the first time: make its record at `pinOrder` (shown, not hidden). False when there is no
 *  connection to make it with (said once); the caller then moves nothing. The writer reports a refusal (and rethrows). */
export async function placeContentTab(args: { owner: ViewOwner; takenNames: readonly string[]; pinOrder: number; online: boolean }): Promise<boolean> {
  if (!args.online) { addToast(MOVE_NEEDS_CONNECTION(), "info"); return false; }
  // Stored under the English word, as hideContentTab stores it; the row shows it in the person's own language.
  await viewWriter.create(args.owner, { name: freeViewName("Content", args.takenNames), layout: "content", visible_fields: [], pin_order: args.pinOrder }, MOVE_NEEDS_CONNECTION());
  return true;
}

/** The person may change the note: the tab can be added back by them. */
function mayChange(nodeId: string, isOwner: boolean): boolean {
  const node = getNode(nodeId);
  const spaces = [...loadedSpaces()];
  return !!node && capabilitiesFor(isOwner, spaces, spaces.length > 0).canEdit(node);
}

const CANNOT_PUT_BACK = () => t("The text of this note is tucked away, and you don't have permission to put its tab back.");

let askingFor: string | null = null;
const toldAbout = new Set<string>();

/** The page is (or is about to be) on 「內容」 of a note that has had it removed, or something is waiting to land in its text (a
 *  caret, a search result's words). The page already shows the note's default tab. Something waiting asks once to add the tab
 *  back: yes shows the text where it lands; no, a refusal or the person having gone elsewhere drops the jump and leaves nothing
 *  pending for a later visit. Nothing waiting (a palette command, Back onto an old entry, another device's change): it says once per
 *  note where the text is, or, to one who may not change the note, that it is tucked away. */
export async function settleRemovedContent(args: {
  id: string; waiting: boolean; isOwner: boolean; confirm: Confirm; show: (key: string) => void; stillOn: () => boolean;
}): Promise<void> {
  const { id } = args;
  if (!args.waiting) {
    if (toldAbout.has(id)) return;
    toldAbout.add(id);
    addToast(mayChange(id, args.isOwner) ? t("The text is still there. Add the 「Content」 tab back from ＋ to see it.") : CANNOT_PUT_BACK(), "info");
    return;
  }
  if (askingFor === id) return;
  askingFor = id;
  let added = false;
  try {
    added = await askToAddBack(id, args);
  } finally {
    askingFor = null;
  }
  if (added && args.stillOn()) args.show("content"); // the editor takes what was waiting when it opens
  else dropPendingTextJump(id);
}

async function askToAddBack(nodeId: string, { isOwner, confirm }: { isOwner: boolean; confirm: Confirm }): Promise<boolean> {
  await reloadOwnerViews({ kind: "node", id: nodeId });
  const record = contentTabIn(peekOwnerViews({ kind: "node", id: nodeId }));
  if (!record || !isTabHidden(record)) return true;
  if (!mayChange(nodeId, isOwner)) { addToast(CANNOT_PUT_BACK(), "info"); return false; }
  if (!(await confirm(t("This note has no content tab. Add it?"), { confirmLabel: t("Add tab") }))) return false;
  try {
    return await showContentTab(nodeId);
  } catch {
    return false; // The writer already told the person why.
  }
}

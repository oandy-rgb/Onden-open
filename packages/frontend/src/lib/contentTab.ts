// A note's 「內容」 tab can be hidden (lib/viewTabs: the record of layout "content" says so) while its text stays the
// note's body. Anything that needs a place in the text goes through here: it shows the tab again, last among the tabs,
// and never touches the text itself. Queues offline like any view write.

import { addToast } from "./appStore";
import { viewWriter } from "./data";
import { t } from "./i18n";
import { peekOwnerViews, reloadOwnerViews } from "./ownerViews";
import { contentTabIn, isTabHidden } from "./viewTabs";

/** The note's 「內容」 tab shows when this resolves: shown again, last among the tabs, when it was hidden. */
export async function showContentTab(nodeId: string): Promise<void> {
  const owner = { kind: "node", id: nodeId } as const;
  await reloadOwnerViews(owner);
  const views = peekOwnerViews(owner);
  const record = contentTabIn(views);
  if (!record || !isTabHidden(record)) return;
  const last = views.reduce((place, view) => (view === record ? place : Math.max(place, view.pin_order)), -1) + 1;
  await viewWriter.update(owner, record.id, { layout_config_patch: { hidden: null }, pin_order: last });
  await reloadOwnerViews(owner);
}

/** For an action that needs the note's text on screen (a link that lands on a line of it): true when the tab shows
 *  or was just added back, false when the person declined, may not change the note, or the write was refused (nothing
 *  was typed away: the caller drops only the action). */
export async function ensureContentTab(
  nodeId: string,
  { canManage, confirm }: { canManage: boolean; confirm: (message: string, options?: { confirmLabel?: string }) => Promise<boolean> },
): Promise<boolean> {
  await reloadOwnerViews({ kind: "node", id: nodeId });
  const record = contentTabIn(peekOwnerViews({ kind: "node", id: nodeId }));
  if (!record || !isTabHidden(record)) return true;
  if (!canManage) { addToast(t("You can't change this note."), "info"); return false; }
  if (!(await confirm(t("This note has no content tab. Add it?"), { confirmLabel: t("Add tab") }))) return false;
  try {
    await showContentTab(nodeId);
    return true;
  } catch {
    return false; // The writer already told the person why.
  }
}

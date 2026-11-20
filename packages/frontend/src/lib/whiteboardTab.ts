// A note's whiteboard is a tab of the note itself (docs/architecture/canvas-as-view.md),
// so "give this note a board" only ever means giving it that tab — never a second
// note titled like it, which is what "build a board from the sub-notes" and "open a
// card as a sub-board" used to make (migration 139 folded those copies back).

import { viewWriter } from "./data";
import { t } from "./i18n";
import { peekOwnerViews, reloadOwnerViews } from "./ownerViews";
import { freeViewName, isTabHidden } from "./viewTabs";
import { whiteboardTabIn } from "./whiteboardNote";

/** The note has a visible whiteboard tab when this resolves: added when it had
 *  none, shown again when the person had hidden it (its board is kept either
 *  way). Never changes which tab the note opens on. Queues offline like any view write. */
export async function ensureWhiteboardTab(nodeId: string): Promise<void> {
  const owner = { kind: "node", id: nodeId } as const;
  await reloadOwnerViews(owner);
  const views = peekOwnerViews(owner);
  const tab = whiteboardTabIn(views);
  if (!tab) {
    await viewWriter.create(owner, {
      name: freeViewName(t("Canvas"), views.map((view) => view.name)), layout: "canvas", visible_fields: [], pin_order: views.length,
    });
  } else if (isTabHidden(tab)) {
    await viewWriter.update(owner, tab.id, { layout_config_patch: { hidden: null } });
  } else {
    return;
  }
  await reloadOwnerViews(owner);
}

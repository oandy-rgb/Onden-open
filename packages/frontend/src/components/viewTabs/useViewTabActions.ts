import { useCallback, useState } from "react";
import { canvasWriter, viewWriter, type ViewInput, type ViewOwner } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { reloadOwnerViews, type SavedView } from "../../lib/ownerViews";
import { freeViewName, reorderTabs, type ViewTab } from "../../lib/viewTabs";
import { confirmDialog } from "../ConfirmDialog";
import { whiteboardTabIn } from "../../lib/whiteboardNote";

// What the tab row changes: add a view or the whiteboard, rename, remove, move.
// Each is one write to the owner's saved views, then one re-read, so every
// screen showing the tabs sees the same list. Writers report their own
// failures once; a refused write leaves the tabs as they were.
//
// The whiteboard is stored as a view of layout "canvas" (lib/viewTabs). A
// board that only exists because cards sit on it has no record until its tab
// is renamed, moved or removed; removing the tab keeps a record that says the
// tab is hidden. Neither touches the board's layout or its cards.

export function useViewTabActions(owner: ViewOwner, tabs: readonly ViewTab[], views: readonly SavedView[]) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const takenNames = views.filter((view) => !view.inherited_from).map((view) => view.name);
  const whiteboard = whiteboardTabIn(views);

  /** Run one change as the busy state, then re-read the tabs. A refusal was
   *  reported by the writer; the tabs stay as they were. */
  const run = useCallback(async <T,>(change: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    try {
      return await change();
    } catch {
      return null;
    } finally {
      await reloadOwnerViews(owner);
      setBusy(false);
    }
  }, [owner]);

  const create = useCallback(
    (input: ViewInput) => run(() => viewWriter.create(owner, input)),
    [owner, run],
  );

  /** The whiteboard becomes a tab: its hidden record is shown again, or one is made. */
  const addWhiteboard = useCallback(async () => {
    if (whiteboard) {
      await run(async () => {
        await viewWriter.update(owner, whiteboard.id, { layout_config_patch: { hidden: null } });
        if (owner.kind === "node") await canvasWriter.setListed(owner.id, true);
      });
      return;
    }
    await run(() => viewWriter.create(owner, {
      name: freeViewName(t("Canvas"), takenNames), layout: "canvas", visible_fields: [], pin_order: tabs.length,
    }));
  }, [owner, run, t, takenNames, tabs.length, whiteboard]);

  /** Store a whiteboard that so far only showed because it has cards. */
  const storeWhiteboard = (extra: Partial<ViewInput> = {}) =>
    viewWriter.create(owner, { name: freeViewName(t("Canvas"), takenNames), layout: "canvas", visible_fields: [], ...extra });

  const rename = useCallback(async (tab: ViewTab, name: string) => {
    const next = name.trim();
    if (!next || next === tab.name) return;
    await run(async () => {
      if (tab.view) await viewWriter.update(owner, tab.view.id, { name: next });
      else await viewWriter.create(owner, { name: freeViewName(next, takenNames), layout: "canvas", visible_fields: [] });
    });
  }, [owner, run, takenNames]);

  /** Remove a tab. A view goes (its notes stay); the whiteboard only stops
   *  showing as a tab (its board and cards stay). `afterConfirm` runs once the
   *  person confirmed, before the write. False when the person declined. */
  const remove = useCallback(async (tab: ViewTab, afterConfirm?: () => void): Promise<boolean> => {
    const message = tab.kind === "canvas"
      ? t("Remove the “{name}” tab? The board and its cards stay; only the tab goes.", { name: tab.name })
      : t("Delete the view “{name}”? The notes stay; only this way of showing them goes.", { name: tab.name });
    const ok = await confirmDialog(message, { confirmLabel: tab.kind === "canvas" ? t("Remove") : t("Delete"), danger: true });
    if (!ok) return false;
    afterConfirm?.();
    await run(async () => {
      if (tab.kind === "canvas") {
        if (tab.view) await viewWriter.update(owner, tab.view.id, { layout_config_patch: { hidden: true } });
        else await storeWhiteboard({ layout_config: { hidden: true } });
        // A hidden tab takes its board off "Appears on canvases" (its cards stay).
        if (owner.kind === "node") await canvasWriter.setListed(owner.id, false);
      } else if (tab.view) {
        await viewWriter.remove(owner, tab.view.id);
      }
    });
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- storeWhiteboard only reads values already listed
  }, [owner, run, t, takenNames]);

  /** Drop `tab` at `index` among the tabs after 「內容」. */
  const move = useCallback(async (tab: ViewTab, index: number) => {
    const changes = reorderTabs(tabs, tab.key, index);
    if (changes.length === 0) return;
    await run(async () => {
      for (const { tab: moved, pinOrder } of changes) {
        if (moved.view) await viewWriter.update(owner, moved.view.id, { pin_order: pinOrder });
        else await storeWhiteboard({ pin_order: pinOrder });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- storeWhiteboard only reads values already listed
  }, [owner, run, tabs, takenNames]);

  /** 「Make a variation…」: a copy of a view's settings, right after it, named
   *  as the original is (a free name; the settings rename it once they change
   *  what sets it apart). Resolves to the new view's id; null when refused. */
  const duplicate = useCallback(async (tab: ViewTab): Promise<string | null> => {
    const source = tab.view;
    if (!source || tab.kind !== "view") return null;
    const movable = tabs.filter((candidate) => candidate.kind !== "content");
    const at = movable.findIndex((candidate) => candidate.key === tab.key) + 1;
    return run(async () => {
      const id = await viewWriter.create(owner, {
        name: freeViewName(source.name, takenNames), layout: source.layout, filters: source.filters, sorts: source.sorts,
        group_by: source.group_by, visible_fields: source.visible_fields, layout_config: source.layout_config, pin_order: at,
      });
      // The tabs after the source make room: each moves one place on.
      for (const [offset, later] of movable.slice(at).entries()) {
        if (later.view) await viewWriter.update(owner, later.view.id, { pin_order: at + 1 + offset });
        else await storeWhiteboard({ pin_order: at + 1 + offset });
      }
      return id;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- storeWhiteboard only reads values already listed
  }, [owner, run, tabs, takenNames]);

  return { busy, takenNames, create, addWhiteboard, rename, remove, move, duplicate };
}

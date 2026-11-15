import { useEffect, useMemo, useRef, useState } from "react";
import { runBackgroundWrite, viewWriter } from "../lib/data";
import { peekOwnerViews, reloadOwnerViews, useOwnerViews } from "../lib/ownerViews";
import { ensureWhiteboardTab } from "../lib/whiteboardTab";
import { whiteboardTabIn } from "../lib/whiteboardNote";

/** One key of a whiteboard tab's `layout_config`: how to read it and how to put it back. */
export type BoardTabSetting<T> = {
  read: (layoutConfig: Record<string, unknown> | null | undefined) => T;
  /** Put the setting into `layoutConfig`. Called with `{}` to learn which keys the setting owns: it must set
   *  only its own keys, nothing derived from the other keys already there. */
  write: (layoutConfig: Record<string, unknown>, settings: T) => Record<string, unknown>;
};

/** Store one setting in a board's whiteboard tab (giving the note one first if it has none), leaving the
 *  tab's other layout_config keys alone; writes to one board's tab go one after another. The hook's save uses it; so does a write outside a component
 *  (an imported .canvas board starts in manual layout, useCanvasActions). */
export function writeBoardTabSetting<T>(boardId: string, setting: BoardTabSetting<T>, settings: T): Promise<void> {
  // Every setting of a board lives in one layout_config; a write names only its own keys (a patch), so two devices
  // changing different settings keep both. On one device the writes still go one lane per board: each reads what
  // the one before it saved, so its patch is computed against the latest copy.
  const run = (lanes.get(boardId) ?? Promise.resolve()).then(() => writeInLane(boardId, setting, settings));
  const lane = run.catch(() => undefined);
  lanes.set(boardId, lane);
  void lane.then(() => { if (lanes.get(boardId) === lane) lanes.delete(boardId); });
  return run;
}
const lanes = new Map<string, Promise<void>>();

async function writeInLane<T>(boardId: string, setting: BoardTabSetting<T>, settings: T): Promise<void> {
  const owner = { kind: "node", id: boardId } as const;
  await ensureWhiteboardTab(boardId);
  const tab = whiteboardTabIn(peekOwnerViews(owner));
  if (!tab) return;
  // Only this setting's own keys go to the server and into the offline queue: written onto an empty config,
  // `write` yields exactly them. Other settings of the board, including another device's, are not part of it.
  const own = setting.write({}, settings);
  const patch = Object.fromEntries(Object.entries(own).map(([key, value]) => [key, value ?? null]));
  await viewWriter.update(owner, tab.id, { layout_config_patch: patch });
  await reloadOwnerViews(owner);
}

/**
 * A setting kept in a note board's whiteboard tab (the tree's, the card display's),
 * with the person's latest choice shown at once while it is being saved.
 *
 * Looking never writes. `save` is the first write a board's tab sees for this:
 * it gives a note that has no tab one (what the board's other first writes do
 * too, lib/whiteboardTab) and then changes only this setting's key of the tab's
 * layout_config. Saves go one after another, each carrying the whole setting,
 * so the last choice wins.
 */
export function useBoardTabSetting<T>(boardId: string | null, setting: BoardTabSetting<T>) {
  const { views } = useOwnerViews(boardId ? { kind: "node", id: boardId } : null);
  const stored = useMemo(() => setting.read(whiteboardTabIn(views)?.layout_config), [views, setting]);
  const [pending, setPending] = useState<{ boardId: string; settings: T } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const shown = pending && pending.boardId === boardId ? pending.settings : stored;
  // The tab caught up (or someone else changed it): the stored value is the truth again.
  const storedKey = JSON.stringify(stored);
  useEffect(() => {
    if (pending && (pending.boardId !== boardId || JSON.stringify(pending.settings) === storedKey)) setPending(null);
  }, [pending, boardId, storedKey]);

  const save = (settings: T) => {
    if (!boardId) return;
    setPending({ boardId, settings });
    const write = async () => {
      try {
        await writeBoardTabSetting(boardId, setting, settings);
      } finally {
        // Only this save's own display; a later choice keeps showing.
        setPending((current) => current?.settings === settings ? null : current);
      }
    };
    const run = queue.current.then(write, write);
    queue.current = run.catch(() => undefined);
    runBackgroundWrite(run);
  };

  return { settings: shown, save };
}

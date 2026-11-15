// Which space the workspace History screen is narrowed to. WorkspaceHistory owns the choice
// (useHistorySpaceChoice) and hands it down through the context, so the feed, the chart, the
// deleted list and the note rows read one place — and so does anything added to the screen later.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getPref, PREFS, removePref, setPref } from "../../lib/prefs";
import { spaceLabel, useSpaces, type Space } from "../../lib/spaces";
import type { HistorySpace } from "../../lib/history";

export type HistorySpaceView = {
  /** The space History is narrowed to; null = every space the person can read. */
  spaceId: HistorySpace;
  setSpaceId: (id: HistorySpace) => void;
  /** The spaces the person can pick from (empty or one: no picker is offered). */
  spaces: readonly Space[];
  /** The name to show beside a note, or null when no name should be shown:
   *  a single space is chosen (every row would say the same), the person has
   *  only one space, or the note is in none. */
  labelFor: (noteSpaceId: string | null | undefined) => string | null;
};

const ALL_SPACES: HistorySpaceView = { spaceId: null, setSpaceId: () => {}, spaces: [], labelFor: () => null };

export const HistorySpaceContext = createContext<HistorySpaceView>(ALL_SPACES);

export function useHistorySpace(): HistorySpaceView {
  return useContext(HistorySpaceContext);
}

/** The choice, remembered per account. A remembered space that is gone, or that the person can
 *  no longer read, counts as 「全部空間」 once the spaces have loaded. */
export function useHistorySpaceChoice(online: boolean): HistorySpaceView {
  const { spaces: all, loaded } = useSpaces(online);
  const [stored, setStored] = useState<string | null>(() => getPref(PREFS.historySpace) || null);
  const spaces = useMemo(() => all.filter((s) => s.kind !== "system"), [all]);
  const pickable = spaces.length >= 2;
  // Until the list is known the remembered id is trusted, so a returning person's first load is already narrowed.
  const spaceId = pickable
    ? (stored !== null && spaces.some((s) => s.id === stored) ? stored : null)
    : loaded ? null : stored;

  const setSpaceId = useCallback((id: HistorySpace) => {
    setStored(id);
    if (id === null) removePref(PREFS.historySpace); else setPref(PREFS.historySpace, id);
  }, []);
  const labelFor = useCallback((noteSpaceId: string | null | undefined) => {
    if (!pickable || spaceId !== null || !noteSpaceId) return null;
    const space = spaces.find((s) => s.id === noteSpaceId);
    return space ? spaceLabel(space) : null;
  }, [pickable, spaceId, spaces]);

  return useMemo(() => ({ spaceId, setSpaceId, spaces: pickable ? spaces : [], labelFor }), [spaceId, setSpaceId, spaces, pickable, labelFor]);
}

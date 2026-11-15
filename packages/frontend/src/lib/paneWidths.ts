// Desktop widths of the notes list (left) and the info pane (right), set by
// dragging components/ui/PaneResizer. Kept per device: screens differ, an
// account's other devices don't want this one's widths.
//
// A stored width is the person's choice and is never rewritten to fit the
// window. `fitPaneWidths` squeezes the stored pair on the fly so the middle
// keeps MIN_CENTER_WIDTH, and `usePaneWidthVars` publishes the result as the
// CSS variables the two grids read (styles/global.css, ObsidianImport.css).
// An unset width publishes nothing: the stylesheet default applies.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { PREFS, getPref, removePref, setPref, type Pref } from "./prefs";

export type PaneSide = "sidebar" | "inspector";

export const MIN_CENTER_WIDTH = 360;
/** The grids only have side columns above this width (global.css's 900px query). */
export const SIDE_PANES_MIN_VIEWPORT = 901;

export const PANE_LIMITS: Record<PaneSide, { min: number; max: number; fallback: number; pref: Pref; cssVar: string }> = {
  sidebar: { min: 180, max: 480, fallback: 240, pref: PREFS.sidebarWidth, cssVar: "--onden-sidebar-width" },
  inspector: { min: 240, max: 560, fallback: 300, pref: PREFS.inspectorWidth, cssVar: "--onden-inspector-width" },
};
/** The info pane's widest default (other lenses use minmax(300px, 340px)); used only to budget room. */
const INSPECTOR_DEFAULT_WIDEST = 340;

export type StoredWidths = Record<PaneSide, number | null>;
/** Which side panes are on screen: a folded one takes no width. */
export type ShownPanes = Record<PaneSide, boolean>;

export function clampPaneWidth(side: PaneSide, px: number): number {
  const { min, max } = PANE_LIMITS[side];
  return Math.min(max, Math.max(min, Math.round(px)));
}

const defaultWidth = (side: PaneSide) => (side === "inspector" ? INSPECTOR_DEFAULT_WIDEST : PANE_LIMITS.sidebar.fallback);

/** The stored widths squeezed so the middle keeps MIN_CENTER_WIDTH: the room taken
 *  from each shown pane is proportional to how far it is above its own minimum.
 *  A folded pane takes none (its stored width is passed through). Unset stays null. */
export function fitPaneWidths(stored: StoredWidths, viewport: number, shown: ShownPanes): StoredWidths {
  const width = (side: PaneSide) => clampPaneWidth(side, stored[side] ?? defaultWidth(side));
  const taken = (side: PaneSide) => (shown[side] ? width(side) : 0);
  const slackOf = (side: PaneSide) => (shown[side] ? width(side) - PANE_LIMITS[side].min : 0);
  const over = taken("sidebar") + taken("inspector") - (viewport - MIN_CENTER_WIDTH);
  const slack = slackOf("sidebar") + slackOf("inspector");
  const cut = over > 0 && slack > 0 ? Math.min(over, slack) / slack : 0;
  const fit = (side: PaneSide) => (stored[side] === null ? null : Math.round(width(side) - slackOf(side) * cut));
  return { sidebar: fit("sidebar"), inspector: fit("inspector") };
}

/** The widest `side` may be dragged: its limit, or what leaves the middle and the other shown pane their room. */
export function maxPaneWidth(side: PaneSide, fitted: StoredWidths, viewport: number, shown: ShownPanes): number {
  const otherSide = side === "sidebar" ? "inspector" : "sidebar";
  const other = shown[otherSide] ? fitted[otherSide] ?? defaultWidth(otherSide) : 0;
  const room = viewport - MIN_CENTER_WIDTH - other;
  return Math.max(PANE_LIMITS[side].min, Math.min(PANE_LIMITS[side].max, room));
}

/** A drag that ends this far (px) below a pane's minimum width folds the pane away. */
export const COLLAPSE_DRAG_OVERSHOOT = 48;

const COLLAPSE_EVENT = "onden:collapse-pane";

/** Ask the shell to fold `side` away (PaneResizer, after a drag past the minimum);
 *  the shell owns the open/closed state (hooks/useWorkspacePanes). The stored
 *  width is left alone, so opening the pane again restores it. */
export function collapsePane(side: PaneSide): void {
  window.dispatchEvent(new CustomEvent<PaneSide>(COLLAPSE_EVENT, { detail: side }));
}

/** The shell's listener; returns the unsubscribe. */
export function onPaneCollapseRequest(collapse: (side: PaneSide) => void): () => void {
  const handler = (event: Event) => collapse((event as CustomEvent<PaneSide>).detail);
  window.addEventListener(COLLAPSE_EVENT, handler);
  return () => window.removeEventListener(COLLAPSE_EVENT, handler);
}

function readStored(side: PaneSide): number | null {
  const n = Number(getPref(PANE_LIMITS[side].pref));
  return Number.isFinite(n) && n > 0 ? clampPaneWidth(side, n) : null;
}

type Snapshot = { stored: StoredWidths; viewport: number; shown: ShownPanes };

let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();

function current(): Snapshot {
  return snapshot ??= {
    stored: { sidebar: readStored("sidebar"), inspector: readStored("inspector") },
    viewport: typeof window === "undefined" ? SIDE_PANES_MIN_VIEWPORT : window.innerWidth,
    shown: { sidebar: true, inspector: false },
  };
}

function update(patch: Partial<Snapshot>) {
  snapshot = { ...current(), ...patch };
  listeners.forEach((l) => l());
}

/** Store the width the person chose (null = back to the default). Write-through. */
export function setPaneWidth(side: PaneSide, px: number | null) {
  const { pref } = PANE_LIMITS[side];
  const next = px === null ? null : clampPaneWidth(side, px);
  if (next === null) removePref(pref); else setPref(pref, String(next));
  update({ stored: { ...current().stored, [side]: next } });
}

function subscribe(listener: () => void) {
  const onResize = () => { if (window.innerWidth !== current().viewport) update({ viewport: window.innerWidth }); };
  if (listeners.size === 0) window.addEventListener("resize", onResize);
  listeners.add(listener);
  onResize(); // the window may have resized while nothing was listening
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("resize", onResize);
  };
}

export function usePaneWidthState() {
  const { stored, viewport, shown } = useSyncExternalStore(subscribe, current, current);
  return { stored, viewport, shown, fitted: fitPaneWidths(stored, viewport, shown), desktop: viewport >= SIDE_PANES_MIN_VIEWPORT };
}

/** Publish the widths as CSS variables on the page. Mount once, where the grid is. */
export function usePaneWidthVars(shown: ShownPanes) {
  useEffect(() => { update({ shown: { sidebar: shown.sidebar, inspector: shown.inspector } }); }, [shown.sidebar, shown.inspector]);
  const { fitted, desktop } = usePaneWidthState();
  useEffect(() => {
    const root = document.documentElement.style;
    const applied: string[] = [];
    for (const side of ["sidebar", "inspector"] as const) {
      const px = fitted[side];
      if (desktop && px !== null) { root.setProperty(PANE_LIMITS[side].cssVar, `${px}px`); applied.push(PANE_LIMITS[side].cssVar); }
    }
    return () => applied.forEach((name) => root.removeProperty(name));
  }, [fitted.sidebar, fitted.inspector, desktop]); // eslint-disable-line react-hooks/exhaustive-deps -- fitted is rebuilt each render; its two numbers are the inputs
}

/** A list column inside a page (the reader's): one page's own layout, so it is
 *  not one of the shell's panes above and takes no part in fitting them. */
export type PaneColumn = { min: number; max: number; fallback: number; pref: Pref };

/** The width the person chose for `column` (null = the stylesheet's), kept per
 *  device like the side panes, and the way to change it. */
export function useColumnWidth({ min, max, pref }: PaneColumn): [number | null, (px: number | null) => void] {
  const clamp = useCallback((px: number) => Math.min(max, Math.max(min, Math.round(px))), [min, max]);
  const [width, setWidth] = useState(() => {
    const n = Number(getPref(pref));
    return Number.isFinite(n) && n > 0 ? clamp(n) : null;
  });
  const set = useCallback((px: number | null) => {
    const next = px === null ? null : clamp(px);
    if (next === null) removePref(pref); else setPref(pref, String(next));
    setWidth(next);
  }, [clamp, pref]);
  return [width, set];
}

// "放大": a pane (the PDF viewer) fills the whole app window. The state is the
// app's own, not the browser's, so it can be remembered per note (this device,
// this account): leaving the note and coming back, or reloading, opens it
// still enlarged. The browser's Fullscreen API cannot do that — it ends when
// the element unmounts and may only start from a tap.
//
// `enter` also asks the browser for fullscreen on the whole page (inside the
// tap that called it). The page, not the pane, is the fullscreen element, so
// moving to another note keeps the browser fullscreen. Where fullscreen is
// unsupported (iPad Safari, an installed PWA window) only the in-app
// enlargement happens. If the browser leaves fullscreen by itself (a system
// gesture) the enlargement stays: the person asked to enlarge. `exit` and
// Esc end both and forget the note.
//
// There is deliberately no double-click shortcut: on a tablet a double tap on
// the PDF is selecting a word or two quick pen taps, and it kept throwing the
// view into fullscreen.

import { useCallback, useState } from "react";
import { getPrefJson, PREFS, setPrefJson } from "../lib/prefs";
import { useDismiss } from "./useEscapeKey";

function readExpandedIds(): Record<string, true> {
  const raw = getPrefJson(PREFS.expandedPanes);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, true>) } : {};
}

function isExpandedFor(nodeId: string | undefined): boolean {
  return nodeId !== undefined && readExpandedIds()[nodeId] === true;
}

function remember(nodeId: string | undefined, expanded: boolean) {
  if (nodeId === undefined) return;
  const ids = readExpandedIds();
  if (expanded) ids[nodeId] = true;
  else delete ids[nodeId];
  setPrefJson(PREFS.expandedPanes, ids);
}

export function useExpandedPane(nodeId: string | undefined): {
  expanded: boolean;
  enter: () => void;
  exit: () => void;
} {
  const [state, setState] = useState(() => ({ nodeId, expanded: isExpandedFor(nodeId) }));
  // A different note is its own pane: read its memory instead of the last one's.
  const current = state.nodeId === nodeId ? state : { nodeId, expanded: isExpandedFor(nodeId) };
  if (current !== state) setState(current);
  const expanded = current.expanded;

  const enter = useCallback(() => {
    remember(nodeId, true);
    setState({ nodeId, expanded: true });
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) {
      try { void root.requestFullscreen().catch(() => {}); } catch { /* app enlargement alone is enough */ }
    }
  }, [nodeId]);

  const exit = useCallback(() => {
    remember(nodeId, false);
    setState({ nodeId, expanded: false });
    if (document.fullscreenElement === document.documentElement) void document.exitFullscreen?.().catch(() => {});
  }, [nodeId]);

  useDismiss(() => { exit(); }, expanded);

  return { expanded, enter, exit };
}

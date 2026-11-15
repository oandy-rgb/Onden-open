import { useEffect, useState } from "react";
import { useSelectedId } from "../lib/appStore";
import { PREFS, usePersistedFlag } from "../lib/prefs";
import { onPaneCollapseRequest } from "../lib/paneWidths";
import { pageLayout } from "./shellNavigation";
import { useStableCallback } from "./useStableCallback";
import { isMobileLayout } from "./useIsMobile";
import type { AppMode } from "./useUiMode";

/** Below this width (a tablet held upright) the sidebar plus an open inspector
 *  leave the editor about 400px — too narrow to write or draw in. */
const THREE_PANE_MIN_WIDTH = 1000;
const openInspectorByDefault = () =>
  isMobileLayout() || typeof window === "undefined" || window.innerWidth >= THREE_PANE_MIN_WIDTH;

/**
 * The supporting panes around the open view: the notes list (sidebar), the
 * inspector (open, collapsed) and focus mode (both sides at once), all
 * persisted per device. On a note's whiteboard tab (`boardTab`) and in 並排 (`sideBySide`:
 * the note's text also open on the right) the inspector starts folded and only that
 * place's own choice opens it again; the stored choice
 * is not touched, so the content tab comes back as the person left it. The top bar's two-cell switch drives sidebar and
 * inspector separately; focus mode stays on its chord and the palette.
 */
export function useWorkspacePanes(mode: AppMode, { boardTab = false, sideBySide = false }: { boardTab?: boolean; sideBySide?: boolean } = {}) {
  const selectedId = useSelectedId();
  const [storedCollapsed, setInspectorCollapsed] = usePersistedFlag(PREFS.inspectorCollapsed, false);
  // S1: presence is USER-controlled (persisted), not mode-gated — the supporting
  // pane no longer vanishes when you're in notes/overview. Default OPEN: the
  // supporting pane is visible until the user hides it — except where it would
  // squeeze the editor (an upright tablet); there it starts closed, one tap
  // opens it, and the choice is remembered like any other.
  const [storedOpen, setStoredOpen] = usePersistedFlag(PREFS.inspectorOpen, openInspectorByDefault());
  // The whiteboard tab's or 並排's own choice (not stored); leaving forgets it.
  const ownPlace = boardTab || sideBySide;
  const [ownOpen, setOwnOpen] = useState<boolean | null>(null);
  useEffect(() => { if (!ownPlace) setOwnOpen(null); }, [ownPlace]);
  const setInspectorOpen = useStableCallback((open: boolean) => (ownPlace ? setOwnOpen(open) : setStoredOpen(open)));
  // The top bar's info button closes and opens it at every width; a wide
  // window only starts it open.
  const inspectorOpen = ownPlace ? ownOpen ?? false : storedOpen;
  const inspectorCollapsed = storedCollapsed;
  // Focus / distraction-free writing mode — hides the left rail + inspector +
  // chrome and narrows the prose column to a serif "clean page". Persisted,
  // default OFF (the 3-pane layout is the norm).
  const [focusMode, setFocusMode] = usePersistedFlag(PREFS.focusMode, false);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedFlag(PREFS.sidebarCollapsed, false);
  const fullPage = pageLayout(mode) === "full";

  // Outside the notes home the inspector belongs to what was picked on THIS
  // page (a graph node, a task's note): a note left selected on another page
  // is not shown beside an unrelated view.
  const [selectedInMode, setSelectedInMode] = useState(mode);
  useEffect(() => { setSelectedInMode(mode); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps -- record the page a selection was made on
  const showsSelection = mode === "notes" || selectedInMode === mode;
  const inspectorVisible = inspectorOpen && !inspectorCollapsed && (mode !== "notes" || !focusMode);
  // A full page has no list beside it; focus mode folds the list only in the notes home.
  const sidebarVisible = !fullPage && !sidebarCollapsed && (mode !== "notes" || !focusMode);

  const toggleInspector = useStableCallback(() => {
    if (inspectorVisible) { setInspectorOpen(false); return; }
    if (mode === "notes") setFocusMode(false);
    setInspectorCollapsed(false);
    setInspectorOpen(true);
  });
  const toggleSidebar = useStableCallback(() => {
    if (sidebarVisible) { setSidebarCollapsed(true); return; }
    if (mode === "notes") setFocusMode(false);
    setSidebarCollapsed(false);
  });
  const toggleFocus = useStableCallback(() => setFocusMode((v) => !v));
  // A drag past a pane's minimum width folds it (components/ui/PaneResizer).
  useEffect(() => onPaneCollapseRequest((side) => {
    if (side === "sidebar") setSidebarCollapsed(true); else setInspectorOpen(false);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the setters are stable

  /** The phone's Info tab IS the inspector: choosing it opens it, whatever the
   *  persisted desktop state says. */
  const showInspector = useStableCallback(() => { setInspectorOpen(true); setInspectorCollapsed(false); });

  return {
    inspectorOpen, inspectorCollapsed, inspectorVisible, focusMode, showsSelection,
    sidebarCollapsed, sidebarVisible,
    setFocusMode,
    toggleInspector, toggleSidebar, toggleFocus, showInspector,
  };
}

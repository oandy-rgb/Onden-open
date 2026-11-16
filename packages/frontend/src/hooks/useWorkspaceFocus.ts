import { useEffect, useRef, useState } from "react";
import { isTagBoard } from "../lib/nodeTags";
import { SESSION_KEYS, readSession, removeSession } from "../lib/sessionPrefs";
import { getAppState, isNoteGone, setSelectedId, useAppSelector, getNode, useNode, useOnline, useSelectedId } from "../lib/appStore";
import { runBackgroundWrite } from "../lib/data";
import type { canvasWriter } from "../lib/data";
import type { Canvas } from "../lib/api";
import { peekTreeSettings, treeModeOf } from "../lib/boardTreeSettings";
import { subtreeIdsOf } from "../lib/treeWalk";
import { decideCanvasView } from "../lib/canvasViewDecision";
import { recordOpen } from "../lib/frecency";
import { t } from "../lib/i18n";
import type { NodeLens } from "../lib/nodeLens";
import { CANVAS_TAB, CONTENT_TAB, activeTabKey, buildViewTabs, contentTabIn, defaultTabKey, locationOfTab, rememberTab, rememberedTab } from "../lib/viewTabs";
import { peekOwnerViews, type SavedView } from "../lib/ownerViews";
import { capabilitiesFor, useIsOwner } from "../lib/capabilities";
import { loadedSpaces } from "../lib/spaces";
import { useModuleFilter } from "./useModuleFilter";
import { hiddenNoteViewLayouts } from "../modules";
import { opensOnWhiteboard, ownsBoard } from "../lib/whiteboardNote";
import { useStableCallback } from "./useStableCallback";
import type { useUiMode } from "./useUiMode";
import { markBackNavigation } from "../lib/pageScrollRestore";
import { markHistoryArrival, takeHistoryArrival } from "../lib/historyIntent";
import { navigate, openTrailEntry, pushPageEntry, stepTrailInHistory, type TrailPopStep } from "./useUrlLocation";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

type CanvasWriter = typeof canvasWriter;

/** The note is on the open board: one of its cards, or — on a note's board that
 *  follows its sub-notes — a note below the board's own (a click on a tree card
 *  keeps the board, like a click on any card). */
function onActiveBoard(board: Canvas, nodeId: string): boolean {
  if (board.data.nodes.some((card) => card.nodeId === nodeId)) return true;
  const { data } = getAppState();
  if (isTagBoard(data, board.id)) return false;
  return treeModeOf(peekTreeSettings(board.id), board.data.nodes.length) === "auto" && subtreeIdsOf(data.nodes, board.id).has(nodeId);
}

type Options = {
  ui: Pick<ReturnType<typeof useUiMode>, "mode" | "setMode" | "notesView" | "setNotesView" | "viewTab" | "setViewTab" | "setOverviewMobileTab" | "overviewMobileTab">;
  /** The URL's node, lens and saved-view tab at boot: that node reopens there. */
  initialLocation: { nodeId: string | null; lens: NodeLens; viewTab?: string | null; tabShownByEntry?: boolean };
  /** Board reads and writes; this hook decides when, the writer owns how. */
  boards: { selectCanvas: CanvasWriter["select"]; createCanvas: CanvasWriter["create"] };
  /** Without the whiteboard module no board opens and the canvas lens closes. */
  canvasImported: boolean;
  setCanvasNavStack: (stack: string[]) => void;
  /** The shell's question dialog (components/ConfirmDialog): asked once when a jump into the text meets a note whose 「內容」
   *  was removed (lib/contentTab ensureContentTab). */
  confirm: (message: string, options?: { confirmLabel?: string }) => Promise<boolean>;
};

/**
 * What the user is looking at in the notes workspace: the focused node, the
 * lens it shows in, the board that stays open around it, and the way back.
 *
 * Every "open X" entry point (sidebar, palette, links, agenda, tags, boards)
 * goes through the operations returned here, so the rules below live in one
 * place instead of being repeated, slightly differently, at each caller:
 * - a node reopens in the lens last chosen for it (`setLens`); opening a note
 *   from navigation shows its content;
 * - a board is sticky: selecting a card on it keeps it open, opening a note
 *   from elsewhere closes it;
 * - only link follows push onto the back stack, not plain browsing.
 *
 * Opening never reads or writes note content; board reads go through the
 * canvas writer in the background, like every other board view.
 */
export function useWorkspaceFocus({ ui, initialLocation, boards, canvasImported, setCanvasNavStack, confirm }: Options) {
  const { mode, setMode, notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab } = ui;
  const { selectCanvas, createCanvas } = boards;
  const selectedId = useSelectedId();
  const selectedIdNow = useRef(selectedId);
  selectedIdNow.current = selectedId;
  const data = useAppSelector((s) => s.data);
  const online = useOnline();
  const activeCanvas = useAppSelector((s) => s.activeCanvas);

  const selectedNode = useNode(selectedId) ?? null;
  // Catalog visibility and node readability differ for scoped accounts. A
  // visible tag can open its function page without inventing a readable node.
  const selectedTag = selectedId ? data.tags?.find(tag => tag.id === selectedId) ?? null : null;

  // doc 01 P5 — per-node tab memory: a node reopens on the tab you last
  // CHOSE on it ("content", "canvas" or a saved view's id; lib/viewTabs), this
  // session from the map below and across sessions from the account's
  // rememberedTab. Only explicit tab choices are remembered (see selectTab);
  // Canvas card selection keeps its lens. Seeded from the URL's initial
  // node+lens+tab so a deep link / reload restores correctly — except a plain
  // content location, which is also what a link without a tab means (unless the history entry itself says it showed 「內容」,
  // useUrlLocation's SHOWN_TAB_STATE): a note
  // that opens on its whiteboard then opens there (defaultTabOf).
  const tabByNode = useRef<Record<string, string>>(
    initialLocation.nodeId && (initialLocation.lens !== "editor" || initialLocation.viewTab || initialLocation.tabShownByEntry)
      ? { [initialLocation.nodeId]: activeTabKey({ lens: initialLocation.lens, viewTab: initialLocation.viewTab ?? null }) }
      : {},
  );
  const moduleFilter = useModuleFilter();
  const isOwner = useIsOwner();
  /** The note's saved views: as the tab row last read them, else as the note's own row carries them. */
  const storedViewsOf = (node: NonNullable<ReturnType<typeof getNode>>): readonly SavedView[] => {
    const read = peekOwnerViews({ kind: "node", id: node.id });
    return read.length > 0 ? read : Array.isArray(node.collection_views) ? node.collection_views as unknown as SavedView[] : [];
  };
  /** The tabs the note shows, in order (names are the tab row's business). */
  const tabsOf = (id: string) => {
    const node = getNode(id);
    return buildViewTabs({
      views: node ? storedViewsOf(node) : [], canvasImported, earnsWhiteboard: ownsWhiteboard(id), canManage: false,
      contentName: "", whiteboardName: "", hiddenLayouts: hiddenNoteViewLayouts(moduleFilter, "node"),
    });
  };
  /** 「內容」 was removed from the note's tab row: the text is still its body, but no tab shows it. */
  const contentRemoved = (id: string) => {
    const node = getNode(id);
    return !!node && !!contentTabIn(storedViewsOf(node)) && !tabsOf(id).some((tab) => tab.kind === "content");
  };
  /** The tab a note opens on when no tab was chosen: its whiteboard for a
   *  board that was converted into a note (its tab says so), else 「內容」
   *  (else, once 「內容」 was removed, its first tab showing). */
  const defaultTabOf = (id: string) => {
    const node = getNode(id);
    if (canvasImported && node && opensOnWhiteboard(node)) return CANVAS_TAB;
    // A note whose 「內容」 has a record opens on its first tab showing (lib/viewTabs defaultTabKey); the others on 「內容」.
    return node && contentTabIn(storedViewsOf(node)) ? defaultTabKey(tabsOf(id)) : CONTENT_TAB;
  };
  /** The note has a whiteboard of its own: the tab (as stored, or as just
   *  read by the tab row), cards on its board, or the retired kind 'canvas'. */
  const ownsWhiteboard = (id: string) => {
    const state = getAppState();
    const node = getNode(id);
    if (!node || node.node_type === TAG_NODE_TYPE) return false;
    return ownsBoard(node, state.data.canvas_memberships, peekOwnerViews({ kind: "node", id }));
  };
  /** The tab a node was last left on, if any. */
  const tabOf = (id: string) => {
    const key = tabByNode.current[id] ?? rememberedTab(id);
    // A tab remembered as 「內容」 from before it was removed opens the default tab, not a tab that is not there.
    return key === CONTENT_TAB && contentRemoved(id) ? null : key;
  };
  /** Show a tab of the focused node: the lens and the saved view it means. */
  const showTab = (_id: string, key: string) => {
    const place = locationOfTab(key);
    setNotesView(place.lens);
    setViewTab(place.viewTab);
  };
  /** A jump that wants the caret in the text of a note whose 「內容」 was removed (a backlink to a line): asks once to add the
   *  tab back. Declined or refused: the jump is dropped, nothing else changes. */
  const addContentForCursor = async (id: string) => {
    const node = getNode(id);
    const spaces = [...loadedSpaces()];
    const canManage = !!node && capabilitiesFor(isOwner, spaces, spaces.length > 0).canEdit(node);
    // Loaded when a jump meets a removed tab (a chunk of its own: lib/offlineWarmup keeps it for offline); a chunk that cannot load drops the jump.
    const added = await import("../lib/contentTab").then((mod) => mod.ensureContentTab(id, { canManage, confirm })).catch(() => false);
    if (selectedIdNow.current !== id) return; // the person went elsewhere while the question was open
    if (added) showTab(id, CONTENT_TAB);
    else removeSession(SESSION_KEYS.pendingCursor(id));
  };
  const canvasCardSelection = useRef<string | null>(null);
  // A link opened in a new tab (or on a device without the notes yet) focuses
  // its note before the notes have loaded, so its default tab cannot be read
  // then: the note is decided again once it arrives (the effect after this one).
  const undecidedDefault = useRef<string | null>(null);
  useEffect(() => {
    const selectedOnCanvas = canvasCardSelection.current === selectedId;
    const arrivedFromHistory = takeHistoryArrival(selectedId);
    canvasCardSelection.current = null;
    undecidedDefault.current = null;
    if (!selectedId) return;
    // A backlink/mention jump forces the editor lens AND writes a pendingCursor;
    // the editor MUST mount to consume that one-shot handoff, so don't let the
    // per-node lens memory override it back to a remembered Canvas/Table lens. A
    // citation jump is a read action, not a lens switch.
    const hasPending = !!readSession(SESSION_KEYS.pendingCursor(selectedId));
    const remembered = tabOf(selectedId);
    if (hasPending && contentRemoved(selectedId)) {
      // The caret has to land in the text: show what the note opens on now, and add 「內容」 back only if the person says yes.
      showTab(selectedId, defaultTabOf(selectedId));
      void addContentForCursor(selectedId);
    } else if (hasPending) {
      showTab(selectedId, CONTENT_TAB);
    } else if (arrivedFromHistory) {
      // Back, Forward or a tab tap: the entry's own address named the tab it showed, and it is already on screen.
    } else if (selectedOnCanvas) {
      // Keep a card's current board lens.
    } else if (remembered) {
      showTab(selectedId, remembered);
    } else if (defaultTabOf(selectedId) !== CONTENT_TAB) {
      showTab(selectedId, defaultTabOf(selectedId));
    } else {
      // A tag first opens its functions and members, a note its content.
      const isTag = !!data.tags?.some(tag => tag.id === selectedId);
      if (isTag && notesView !== "editor") setNotesView("editor");
      if (viewTab) setViewTab(null);
      if (!isTag && !getNode(selectedId)) undecidedDefault.current = selectedId;
    }
    // ⌘K frecency: every node focus (from any path — sidebar, palette, wikilink)
    // is an "open" that feeds the palette's open-history ranking.
    recordOpen(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore only when the focused node changes
  }, [selectedId]);
  // A page never shows 「內容」 of a note that has had it removed from its tabs, however it got there (Back onto an earlier
  // page, a reload, a remembered tab, another device's change): it shows the tab the note opens on. The tab row does the same
  // for a tab the person removes while looking at it (ViewTabs), and for the other tabs that can go.
  useEffect(() => {
    if (!selectedId || ui.mode !== "notes" || activeTabKey({ lens: notesView, viewTab }) !== CONTENT_TAB || !contentRemoved(selectedId)) return;
    if (readSession(SESSION_KEYS.pendingCursor(selectedId))) return; // a jump into the text asks first (addContentForCursor)
    showTab(selectedId, defaultTabOf(selectedId));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the page, its tab or the note's own tab records change
  }, [selectedId, ui.mode, notesView, viewTab, selectedNode?.collection_views]);
  // The focused note has arrived after it was focused: it opens on its
  // whiteboard if it would have, unless a tab was chosen in the meantime.
  useEffect(() => {
    const id = undecidedDefault.current;
    if (!id || id !== selectedId || !selectedNode) return;
    undecidedDefault.current = null;
    if (tabOf(id)) return;
    if (defaultTabOf(id) !== CONTENT_TAB) showTab(id, defaultTabOf(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the focused note's row appears
  }, [selectedNode?.id]);

  // Canvas lens: viewing a note's board never creates or writes one
  // (mutate-on-view). A note with no board yet is read as an empty board whose
  // sub-notes lay themselves out (useBoardTree); the first thing the person
  // changes there is what gives the note a whiteboard tab.
  const creatingCanvasRef = useRef(false);
  const autoCanvasRef = useRef<string | null>(null);
  useEffect(() => {
    const decision = decideCanvasView({
      // A scoped account may see a tag without its node row; the tag still
      // names its own board.
      selectedNodeId: selectedTag?.id ?? selectedNode?.id ?? null,
      selectedNodeType: selectedTag ? TAG_NODE_TYPE : selectedNode?.node_type ?? null,
      notesView,
      online,
      prevAutoId: autoCanvasRef.current,
      nodeOnActiveBoard: !!selectedNode && !!activeCanvas && onActiveBoard(activeCanvas, selectedNode.id),
      membershipCanvasId: (data.canvas_memberships ?? []).find((m) => m.node_id === selectedNode?.id)?.canvas_id ?? null,
      ownsWhiteboard: !!selectedNode && ownsWhiteboard(selectedNode.id),
    });
    switch (decision.action) {
      case "noop":
        break;
      case "keep":
        // The user clicked a card already on the board — keep their layout,
        // just remember the id so re-renders don't loop.
        autoCanvasRef.current = selectedNode!.id;
        break;
      case "clearOffline":
        // L6: offline node-switch — drop the PREVIOUS node's board instead of
        // leaving it on screen. Do NOT record autoCanvasRef, so a reconnect
        // (online in deps) re-runs and loads the real board.
        if (activeCanvas) runBackgroundWrite(selectCanvas(null));
        break;
      case "load":
        // Re-entering the lens must REUSE the node's existing board, not spawn a
        // duplicate "auto" canvas per visit.
        autoCanvasRef.current = decision.canvasId === selectedTag?.id ? selectedTag.id : selectedNode!.id;
        runBackgroundWrite(selectCanvas(decision.canvasId));
        break;
    }
  // activeCanvas 刻意不放 deps，只在 selectedNode 切換時觸發
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode?.id, selectedTag?.id, notesView, online]);

  // A board that was opened by id (createBoard) rather than by focusing its
  // note: the sticky open board. Focusing a note shows its whiteboard through
  // the canvas lens (the whiteboard is a view of a note, migration 138), so
  // this only ever follows an explicit open and clears when the focus moves
  // to a node that is not on it.
  const [openBoardId, setOpenBoardId] = useState<string | null>(null);
  useEffect(() => {
    // An explicitly selected local board may precede its node projection.
    if (!openBoardId || selectedId === openBoardId) return;
    const onBoard = !!selectedNode && !!activeCanvas
      && activeCanvas.data.nodes.some((cn) => cn.nodeId === selectedNode.id);
    if (!onBoard) setOpenBoardId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectCanvas stable; board follows focus
  }, [selectedNode?.id]);
  /** The page the tabs, ⋯ and board title belong to: the note (or tag) whose board is open, not the card on it that
   *  is selected, and not nothing when a click on empty board space cleared the selection. Everything else is the
   *  selected note or tag itself. (docs/agents/decisions-ui.md, 筆記與標籤頁的視角分頁) */
  const boardShown = notesView === "canvas" || openBoardId !== null;
  const pageId = boardShown && activeCanvas && selectedId !== activeCanvas.id && (selectedId === null || onActiveBoard(activeCanvas, selectedId))
    ? activeCanvas.id
    : selectedId;
  const pageNode = useNode(pageId) ?? null;
  const pageTag = pageId ? data.tags?.find((tag) => tag.id === pageId) ?? null : null;
  // The whiteboard was removed (module library): leave the board lens and
  // close the open board; its layout is kept and returns on import.
  useEffect(() => {
    if (canvasImported) return;
    if (notesView === "canvas") setNotesView("editor");
    if (openBoardId) setOpenBoardId(null);
    if (activeCanvas) runBackgroundWrite(selectCanvas(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectCanvas and setNotesView are stable
  }, [canvasImported, notesView, openBoardId, activeCanvas?.id]);

  /** Show a node's content in the editor, from navigation (sidebar, palette,
   *  search, a graph/collection pane, a notification). Closes a board the node
   *  is not, and on a phone moves from the list into the note. Mobile-safe
   *  chokepoint (H18): every note-open goes here. */
  const openNote = useStableCallback((id: string, opts: { content?: boolean } = {}) => {
    // Opening a note from navigation is different from selecting its card on
    // a board. Reset both the tab and the sticky board for the note already
    // open, and when the caller wants the text itself (a followed link);
    // otherwise the sidebar appears to do nothing. Any other note reopens on
    // the tab it was left on.
    canvasCardSelection.current = null;
    autoCanvasRef.current = null;
    // The text itself is asked for; a note whose 「內容」 was removed has no such tab, so it opens as it would by itself.
    const key = opts.content && !contentRemoved(id) ? CONTENT_TAB : id === selectedId ? defaultTabOf(id) : tabOf(id) ?? defaultTabOf(id);
    tabByNode.current[id] = key;
    // Asking for the text itself (a followed link, the note already open) is a choice of its tab like any other: a reload shows it too.
    if (opts.content || id === selectedId) rememberTab(id, key, defaultTabOf(id));
    showTab(id, key);
    // The board already open for this very note stays; any other note's
    // board is closed (the canvas lens loads the new one).
    if (!(key === CANVAS_TAB && id === selectedId && notesView === "canvas")) {
      setOpenBoardId(null);
      setCanvasNavStack([]);
      runBackgroundWrite(selectCanvas(null));
    }
    // The note's text shown over its own Info screen is the next page: its address does not change, so no sync writes it.
    if (id === selectedId && ui.overviewMobileTab === "info") pushPageEntry();
    setSelectedId(id);
    setMode("notes");
    setOverviewMobileTab("edit");
    setForwardStack([]);
  });

  // Node navigation trail (the #1 "no way back" linkage seam). A LINK follow
  // (wikilink / backlink / mention / agenda task) pushes the node you came FROM;
  // the topbar's 「上一頁」 pops it and restores that node + its lens, leaving
  // the place it came from on the forward stack for 「下一頁」. Browsing via the
  // sidebar tree does NOT push (it's not a "follow"), so Back returns to the
  // last reference source — Notion's back-arrow / Tana's breadcrumb return —
  // but it does end the forward trail, as a browser's new page does.
  /** `id` null = the notes list (a phone's list screen, or a page whose note was deleted under it). */
  type Place = { id: string | null; tab: string; view: typeof mode };
  const [navStack, setNavStack] = useState<Place[]>([]);
  const [forwardStack, setForwardStack] = useState<Place[]>([]);
  /** Remember the focused node for Back, just before a link follow switches
   *  away. Caps at 50; does nothing without a focused node. */
  const pushNav = useStableCallback(() => {
    if (!selectedId) return;
    openTrailEntry(); // the browser's Back returns here too
    setNavStack((s) => [...s.slice(-49), { id: selectedId, tab: activeTabKey({ lens: notesView, viewTab }), view: mode }]);
  });
  /** Follow a reference to a note: Back returns here, and the note opens in
   *  the editor (a sticky non-editor lens would hide what was tapped). */
  const followLink = useStableCallback((id: string) => {
    // A link to the note already open is no page to come back to (the address would not change either).
    if (id !== selectedId || mode !== "notes") pushNav();
    openNote(id, { content: true });
  });
  // Always a place, the list included: every trail step has a history entry, so a step that left from a page with no note
  // (its note was deleted) must still be one stop on the way back or forward.
  const currentPlace = (): Place => ({ id: selectedId, tab: activeTabKey({ lens: notesView, viewTab }), view: mode });
  const restorePlace = (place: Place) => {
    setMode(place.view); // a link followed from the tasks page returns to it
    // A note deleted since is not a place to return to: the list stands in for it, as for a page of the browser's history.
    const id = place.id !== null && isNoteGone(place.id) ? null : place.id;
    markHistoryArrival(id);
    setSelectedId(id);
    if (id) showTab(id, place.tab);
  };
  // The trail steps below move the focus in state; goBack / goForward take the
  // same step through the browser history when the trail has its entry there
  // (hooks/useUrlLocation), so the browser's own Back / Forward / mouse side
  // buttons and these end in the same place.
  const isPlaceGone = (place: Place) => place.id !== null && isNoteGone(place.id);
  /** `restore` false: the step is only taken in the stacks (its place is gone; the address shows the page). */
  const stepBack = (restore = true) => {
    const prev = navStack[navStack.length - 1];
    if (!prev) return;
    markBackNavigation();
    setForwardStack((s) => [...s.slice(-49), currentPlace()]);
    setNavStack((s) => s.slice(0, -1));
    if (restore) restorePlace(prev);
  };
  const stepForward = (restore = true) => {
    const next = forwardStack[forwardStack.length - 1];
    if (!next) return;
    setNavStack((s) => [...s.slice(-49), currentPlace()]);
    setForwardStack((s) => s.slice(0, -1));
    if (restore) restorePlace(next);
  };
  const goBack = useStableCallback(() => {
    if (navStack.length > 0 && !stepTrailInHistory("back")) stepBack();
  });
  const goForward = useStableCallback(() => {
    if (forwardStack.length > 0 && !stepTrailInHistory("forward")) stepForward();
  });
  /** The browser crossed a trail entry (hooks/useUrlLocation): take the trail's
   *  step the same way (true), or leave the popstate to the URL when the trail
   *  has nothing in that direction. "left": the history jumped off the trail; drop its steps. */
  const followBrowserStep = useStableCallback((step: TrailPopStep): boolean => {
    if (step === "left") { setNavStack([]); setForwardStack([]); return false; }
    // A step to a note that is gone is taken without restoring it: the history passed that entry (useUrlLocation onPop)
    // and shows the page behind it, which is the address.
    if (step === "back" && navStack.length > 0) {
      const gone = isPlaceGone(navStack[navStack.length - 1]!);
      stepBack(!gone);
      return !gone;
    }
    if (step === "forward" && forwardStack.length > 0) {
      const gone = isPlaceGone(forwardStack[forwardStack.length - 1]!);
      stepForward(!gone);
      return !gone;
    }
    return false;
  });

  /** Switch the focused node to a tab of its tab row ("content", "canvas" or a
   *  saved view's id); the node reopens on it next time, on this device too. */
  const selectTab = useStableCallback((key: string) => {
    if (!pageId) return;
    tabByNode.current[pageId] = key;
    rememberTab(pageId, key, defaultTabOf(pageId));
    showTab(pageId, key);
    // A card of the board is selected: the tab is the page's, so the page is what is focused afterwards.
    if (pageId !== selectedId) navigate(() => setSelectedId(pageId), { history: "replace" });
  });
  /** Switch the focused node's lens (content or canvas): a tab of its row. */
  const setLens = useStableCallback((lens: NodeLens) => selectTab(lens === "canvas" ? CANVAS_TAB : CONTENT_TAB));

  // A tag opens as the THING: its function page in the editor.
  const showTag = (tagId: string) => {
    const key = tabOf(tagId) ?? CONTENT_TAB;
    tabByNode.current[tagId] = key;
    showTab(tagId, key);
    setSelectedId(tagId);
    setOverviewMobileTab("edit");
  };
  /** Open a tag by id, from the authorized catalog — even when the tag's node
   *  is outside the reader's scope. An unknown id only switches to notes. */
  const openTag = useStableCallback((tagId: string) => {
    setMode("notes");
    if (getAppState().data.tags?.some(tag => tag.id === tagId)) showTag(tagId);
  });
  /** Land on a tag the caller just created (it may not be in the catalog the
   *  caller rendered with yet), to shape it there. */
  const openNewTag = useStableCallback((tagId: string) => {
    setMode("notes");
    showTag(tagId);
  });

  /** Select from inside the open workspace (a card click, an empty-board
   *  click). Keeps the board: an empty-board click deselects the card, not the
   *  board — a null selection would unmount an editor-hosted board before a
   *  double-click can create a card, and on a phone return to the list. */
  const selectInWorkspace = useStableCallback((id: string | null) => {
    const nextId = id ?? (notesView === "editor" ? openBoardId : null);
    canvasCardSelection.current = nextId !== selectedId ? nextId : null;
    // A card inside the open board is not a page of its own.
    navigate(() => setSelectedId(nextId), { history: "replace" });
  });

  // Location updates do not read or create a board. A confirmed creation can
  // reuse them without another request or changing a later navigation's mode.
  const rememberCanvasLocation = (canvasId: string) => {
    canvasCardSelection.current = null;
    autoCanvasRef.current = canvasId;
    setOpenBoardId(canvasId);
    // Keep the board in the existing node URL even before sync supplies its
    // node projection.
    tabByNode.current[canvasId] = CANVAS_TAB;
    navigate(() => setSelectedId(canvasId), { history: "replace" }); // the board just made, shown where the user already is
  };
  /** Show a board in the canvas lens without changing the focused node. */
  const showBoardInLens = useStableCallback((canvasId: string) => {
    setMode("notes");
    // The focused note is not asked for its own board: the one named is shown.
    autoCanvasRef.current = getAppState().selectedId;
    setNotesView("canvas");
    runBackgroundWrite(selectCanvas(canvasId));
  });
  /** Create an untitled board and open it — unless the user has moved on
   *  meanwhile (a later selection owns the view). One creation at a time. */
  const createBoard = useStableCallback(() => {
    if (creatingCanvasRef.current) return;
    creatingCanvasRef.current = true;
    const selectionBeforeCreate = getAppState().selectedId;
    runBackgroundWrite((async () => {
      try {
        const canvas = await createCanvas(t("Untitled canvas"));
        const current = getAppState();
        if (current.activeCanvas?.id === canvas.id && current.selectedId === selectionBeforeCreate) rememberCanvasLocation(canvas.id);
      } finally {
        creatingCanvasRef.current = false;
      }
    })());
  });
  /** After a card's placement was accepted as removed: if that card is still
   *  selected on the same open board, select the board, so a reload keeps the
   *  board rather than opening the (still existing) note. Never navigates back
   *  once the user has left the board or selected another card. */
  const settleCardRemoval = useStableCallback((canvasId: string, nodeId: string) => {
    if (mode === "notes" && notesView === "editor" && openBoardId === canvasId && getAppState().activeCanvas?.id === canvasId) {
      setSelectedId(current => current === nodeId ? canvasId : current);
    }
  });

  return {
    selectedId, selectedNode, selectedTag,
    /** The page whose tabs are shown: see `pageId` above. */
    pageNode, pageTag,
    openNote, followLink, pushNav, goBack, canGoBack: navStack.length > 0,
    goForward, canGoForward: forwardStack.length > 0, followBrowserStep,
    setLens, selectTab,
    openTag, openNewTag,
    selectInWorkspace,
    /** The board kept open around the focused node, if any. */
    openBoardId,
    showBoardInLens, createBoard, settleCardRemoval,
  };
}

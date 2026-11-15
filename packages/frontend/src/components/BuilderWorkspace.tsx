import { Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { nodeOf } from "../lib/nodeIndex";
import { openNoteColorDialog } from "./NoteColorDialog";
import { lazyWithReload } from "../lib/lazyWithReload";
import { useCardAudienceReview } from "../lib/cardAudienceGate";
import { fontsPref } from "../lib/fontPrefs";
// The notes grid, sidebar and editor share these base styles. Load them with
// the workspace; waiting for the lazy preview leaves the initial editor unstyled.
import "./ObsidianImport.css";
import "../styles/sidebar.css";
import { nodeNeedsBody } from "../lib/api";
import { useAppSelector, setSelectedId, useSelectedId } from "../lib/appStore";
import { canvasWriter, dayNoteParentPref, nodeActions, taskWriter } from "../lib/data";
import { inkAutoShapePref } from "../lib/inkPrefs";
import { useAppData } from "../lib/useAppData";
import { useRegisterTaskRefs } from "../lib/taskRefs.app";
import { classNames } from "../lib/utils";
import { FocusTopMark, isModuleScreen, openQuickCapture } from "../modules";
import { pageLayout } from "../hooks/shellNavigation";
import { usePaneWidthVars } from "../lib/paneWidths";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";
import { useCreateDialog } from "../hooks/useCreateDialog";
import { useCreateTag } from "../hooks/useCreateTag";
import { useDayNoteWrites } from "../hooks/useDayNoteWrites";
import { useFirstRunSeeding } from "../hooks/useFirstRunSeeding";
import { useInboxSidebar } from "../hooks/useInboxSidebar";
import { DecisionsProvider } from "../hooks/DecisionsContext";
import { useLandingNote } from "../hooks/useLandingNote";
import { useLensAvailability } from "../hooks/useLensAvailability";
import { useCanvasImported } from "../hooks/useModuleFilter";
import { useNodeCreation } from "../hooks/useNodeCreation";
import { useNodeLifecycle } from "../hooks/useNodeLifecycle";
import { useNodeSelection } from "../hooks/useNodeSelection";
import { useOverviewMode } from "../hooks/useOverviewMode";
import { useSettingsDialog } from "../hooks/useSettingsDialog";
import { useSidebarDrag } from "../hooks/useSidebarDrag";
import { useStableCallback, useStableHandlers } from "../hooks/useStableCallback";
import { useUiMode } from "../hooks/useUiMode";
import { usePhoneInfoScreen } from "../hooks/usePhoneInfoScreen";
import { noteAddress, readLocation, readRightFromUrl, setGraphFocus, useUrlSync } from "../hooks/useUrlLocation";
import { useWorkspaceCommands } from "../hooks/useWorkspaceCommands";
import { useWorkspaceFocus } from "../hooks/useWorkspaceFocus";
import { useWorkspaceLive } from "../hooks/useWorkspaceLive";
import { useWorkspaceModules } from "../hooks/useWorkspaceModules";
import { resolveWikilink } from "../lib/wikilinks";
import { useSplitView } from "../hooks/useSplitView";
import { applyUrlRight, useKeepSplitPaneSynced } from "../lib/splitViewStore";
import { SPLIT_RATIO_DEFAULT } from "../lib/splitView";
import { QuoteToOther, SplitDivider, SplitDropHint, SplitPane } from "./splitView";
import { useWorkspacePanes } from "../hooks/useWorkspacePanes";
import AccessRevokedNotice from "./AccessRevokedNotice";
import AppTopbar from "./AppTopbar";
import GateTypingBuffer from "./GateTypingBuffer";
import MembershipGate from "./MembershipGate";
import DeviceNotices from "./DeviceNotices";
import MobileNav from "./MobileNav";
import SecondaryLensOutlet from "./SecondaryLensOutlet";
import { usePageScrollRestore } from "../hooks/usePageScrollRestore";
import { useIsMobile } from "../hooks/useIsMobile";
import SideDrawers from "./SideDrawers";
import { openSpacesAndMembers } from "../lib/settingsRequest";
import type { RawShare } from "../lib/share";
import BootScreen from "./BootScreen";
import { useWorkspaceChunks, useOfflineWarmup, NotesWorkspace, NotesCenter, loadWorkspaceContextMenu, WorkspaceInspector, WorkspaceOverlays, WorkspaceSidebar } from "./workspace";
import { isNote } from "@onden/markdown/contract";

const BoardCardAudienceConfirm = lazyWithReload(() => import("./BoardCardAudienceConfirm"));
const KnowledgeWorkspace = lazyWithReload(() => import("./KnowledgeWorkspace"));
const WorkspaceContextMenu = lazyWithReload(() => loadWorkspaceContextMenu());

// The signed-in workspace. BuilderApp (the sign-in gate) loads this module
// lazily, so the login page does not download any of it.
export default function BuilderWorkspace({ sharedDraft = null, openCapture = false }: { sharedDraft?: RawShare | null; openCapture?: boolean }) {
  // Surface S2a: seed the top-level location ({view, nodeId}) from the URL once,
  // so a reload / deep link / shared URL lands in the right place. client:only,
  // so reading window.location in the lazy initializer is safe (no SSR).
  // Selection lives in the app store (H4) — seed it here, in the lazy
  // initializer, so the first render's selectors already see the deep link.
  const [initialLocation] = useState(() => {
    const loc = readLocation({ view: "notes", nodeId: null, lens: "editor" });
    setSelectedId(loc.nodeId);
    // Side by side: the address names the right pane too (lib/splitViewStore).
    applyUrlRight(readRightFromUrl(), true);
    return loc;
  });

  const uiMode = useUiMode(initialLocation.view, initialLocation.lens, initialLocation.viewTab ?? null);
  const {
    mode, setMode,
    notesView, setNotesView,
    viewTab, setViewTab,
    mobileView,
    overviewMobileTab, setOverviewMobileTab,
  } = uiMode;

  const selectedId = useSelectedId();
  // Step D fail-closed display gate: while read-membership may be stale (a
  // permission change pending reconciliation, or a reconcile that failed), cover
  // the workspace so possibly-restricted local content isn't shown until the
  // reconcile converges. This is the real fail-closed lever — the `online` flag
  // does not hide local content.
  const membershipGated = useAppSelector((s) => s.membershipGated);
  const accessRevoked = useAppSelector((s) => s.accessRevoked);
  // The whiteboard (白板) is core code with a library switch: when it is not
  // imported, no board opens and no whiteboard entry shows; boards are kept.
  const canvasImported = useCanvasImported();

  const menus = useNodeSelection();
  const { ctxMenu, setCtxMenu, renamingNodeId, setRenamingNodeId, renameDraft, setRenameDraft } = menus;

  const { createOpen, setCreateOpen, eventsOpen, setEventsOpen, draftTitle, taskTitle, setTaskTitle } = useCreateDialog();

  const {
    data, online, bootstrapped, refresh, sync, hydrateNode,
    activeCanvas,
    createNode: _createNode,
  } = useAppData();
  // Tasks are link and embed targets (`[[` menu, `![[…]]` rows).
  useRegisterTaskRefs(online);

  // Where the user is: the focused node, its lens, the board kept open around
  // it and the way back. Every "open X" below goes through these operations.
  const focus = useWorkspaceFocus({
    ui: uiMode,
    initialLocation,
    boards: { selectCanvas: canvasWriter.select, createCanvas: canvasWriter.create },
    canvasImported,
    setCanvasNavStack: menus.setCanvasNavStack,
  });
  const {
    selectedNode, selectedTag,
    openNote, followLink, pushNav,
    openTag, openNewTag,
  } = focus;

  // Surface S2a/A: keep the location in the URL — place switch and link follow =
  // pushState (back/forward), node/lens change = replaceState (no history
  // spam). lens = the per-node Editor/Canvas view (notesView), persisted
  // across reloads. Back/forward onto the link trail's notes steps the trail.
  const modules = useWorkspaceModules({ setMode, refresh, openNote });
  const { openModule, openModuleScreen } = modules;
  const splitView = useSplitView({
    mode, setMode, selectedId, notesView, viewTab, openNote, selectTab: focus.selectTab, openModuleScreen,
  });
  useKeepSplitPaneSynced();
  const { split } = splitView;
  const splitRootRef = useRef<HTMLDivElement | null>(null);
  // Two sides are for a desktop-width window; a phone shows only the left (the store's canSplit).
  const splitOn = !splitView.phone && split.right !== null;
  // The phone's Back key and ‹ end at the notes list before leaving the app (hooks/useUrlLocation).
  const phoneLayout = useIsMobile();
  const inbox = useInboxSidebar(refresh);
  const dueSoon = useWorkspaceLive({ sync, loadInboxReview: inbox.loadInboxReview, openNote });

  // A removed/rejected note has no detail pane. Keep the requested tab so a
  // deep-linked note can open when loading finishes; canvas browsing does not
  // require a selected card, but its Info pane still requires a note.
  // The note page (editor lens) reaches Info from its ⋯ menu on a phone.
  // The list level is the notes page with nothing opened (`?view=notes`, no node): a selected note is
  // never "the list", whichever level was last asked for (Back onto a note's address shows the note).
  const displayedMobileTab = selectedNode || selectedTag
    ? (overviewMobileTab === "list" ? "edit" : overviewMobileTab)
    : overviewMobileTab === "edit" && notesView === "canvas" ? "edit" : "list";

  const { closeInfo, setNoteFromHistory } = usePhoneInfoScreen({ phone: phoneLayout, tab: displayedMobileTab, selectedId, setTab: setOverviewMobileTab, setSelectedId });
  useUrlSync(mode, selectedId, notesView, setMode, setNoteFromHistory, setNotesView, viewTab, setViewTab, focus.followBrowserStep, split.right, phoneLayout);

  // Phone Back (header, link trail, popstate) returns to the list/note at the
  // page scroll it was left at.
  usePageScrollRestore(
    `${mode}|${displayedMobileTab}|${displayedMobileTab === "list" ? "" : selectedId ?? selectedTag?.id ?? ""}`,
    phoneLayout,
  );

  // The sidebar's drag state and group expansion live here, not in the
  // sidebar: it remounts on every mode switch.
  const sidebarDrag = useSidebarDrag({
    nodes: data.nodes,
    online,
    selectedNodeId: selectedId,
    selectedNodeParentId: selectedNode?.parent_id,
  });

  const overview = useOverviewMode({
    setMode,
    setNotesView,
    onBeforeNavigate: () => pushNav(),
  });
  const { overviewSelectedNode } = overview;

  // Lazy-body hydration (P0-3 stage 2): a node selected while the store still
  // holds its slim-bootstrap row (markdown stripped) fetches its full row on
  // demand. The editor pane stays on a loading placeholder until the swap
  // lands (see the nodeNeedsBody guard at the OverviewEditor render).
  useEffect(() => {
    if (nodeNeedsBody(overviewSelectedNode)) void hydrateNode(overviewSelectedNode!.id);
  }, [overviewSelectedNode?.id, overviewSelectedNode?.body_len, overviewSelectedNode?.markdown, hydrateNode, online]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the fields nodeNeedsBody reads (+ reconnect retries a body that was not here offline)

  const createTagFromSidebar = useCreateTag(openNewTag);

  const lenses = useLensAvailability({ isTag: !!selectedTag, canvasImported });

  useFirstRunSeeding({ refresh });

  const chunksReady = useWorkspaceChunks();
  useOfflineWarmup(bootstrapped && chunksReady && online && !membershipGated);

  // 並排: the note's text open on the left and, rendered, on the right.
  const sideBySide = !splitView.phone && mode === "notes" && notesView === "editor" && !viewTab && !focus.openBoardId
    && split.right?.kind === "note" && split.right.tab === "content" && split.right.id === selectedId;
  const panes = useWorkspacePanes(mode, { boardTab: mode === "notes" && (notesView === "canvas" || (notesView === "editor" && !!focus.openBoardId)), sideBySide });
  const cardAudienceOpen = useCardAudienceReview() !== null;
  const board = useBoardWorkspace({ ui: uiMode, focus, menus, createNodeRaw: _createNode, assignToGroup: nodeActions.assignToGroup, refresh });

  // A1: node-creation / quick-create / upload / pointer handlers live in
  // useNodeCreation, with a placement callback bound to the originating board.
  const creation = useStableHandlers(useNodeCreation({
    data,
    createNodeRaw: _createNode,
    refresh,
    draftTitle,
    setCreateOpen,
    activeCanvas,
    // Creation may finish after navigating elsewhere. Capture its starting
    // board here; the writer will append to that board's latest local layout.
    addToActiveCanvas: (nodeId) => activeCanvas ? board.placeBoardNode(activeCanvas.id, nodeId) : Promise.resolve(),
    setSelectedId,
    setMode,
    openNote,
    openNewTag,
  }));
  const { create, openDailyNote } = creation;
  const createNote = () => create("note");

  // A3: the shell-state handlers (canvas card menu, task form, rename form,
  // context menu). Note actions themselves are lib/data's nodeActions.
  const lifecycle = useStableHandlers(useNodeLifecycle({
    selectedNode,
    taskTitle,
    setTaskTitle,
    renamingNodeId,
    renameDraft,
    setRenamingNodeId,
    setCtxMenu,
  }));

  const settings = useSettingsDialog({ sync, refresh });
  const { palette, openPalette, noteActions } = useWorkspaceCommands({
    ui: uiMode, focus, createDialog: { createOpen, setCreateOpen }, creation, board, modules, panes,
    toggleSplit: splitView.phone ? undefined : () => { void splitView.toggleCurrent(); },
    createNodeRaw: _createNode,
    canvasAvailable: canvasImported && (lenses.hasChildren || lenses.hasBoard),
    refresh,
    openSettings: settings.openSettings,
    openNoteColor: openNoteColorDialog,
  });

  const dayWrites = useDayNoteWrites({ addTaskRaw: taskWriter.create, openDailyNote });
  dayNoteParentPref.useKeepInSync();
  // The account's font choice (Settings › Appearance › Fonts): kept in sync here; resolving it against
  // this device's fonts loads after the first paint (lib/fontApply).
  const fontChoices = fontsPref.useValue().value;
  useEffect(() => { void import("../lib/fontApply").then((m) => m.applyFontChoices(fontChoices)); }, [fontChoices]);
  // 「畫完停住自動修成形狀」 is also changed on the Handwriting settings page.
  inkAutoShapePref.useKeepInSync();
  useLandingNote({ initialLocation, ui: uiMode, openNote, openDailyNote });

  const handleOpenMembers = useStableCallback(() => openSpacesAndMembers());
  // What the top bar opens (desktop, and the phone's avatar sheet).
  const shellNav = {
    mode, setMode,
    onOpenModule: openModuleScreen, onOpenFeature: modules.openFeature, onOpenSettings: settings.openSettings,
    onOpenMembers: handleOpenMembers, onSyncNow: sync, onOpenNote: openNote,
  };
  // The side columns' stored widths, published for the grids (a non-notes lens also needs a selection to have an inspector).
  usePaneWidthVars({
    sidebar: panes.sidebarVisible,
    inspector: panes.inspectorVisible && pageLayout(mode) !== "full" && (mode === "notes" || panes.showsSelection),
  });
  if (!bootstrapped || !chunksReady) return <BootScreen />;

  // The single node inspector (doc 09: one lens-stable pane). Same element used
  // in notes mode (inside the obsidian inner grid) and in every other lens (as a
  // .workspace-grid col-3 sibling) — the two call sites are mutually exclusive
  // by mode, so only one ever mounts. A canvas without a selected card has no
  // note to inspect; the editor's first-note fallback must not expose
  // unrelated writable fields.
  const inspectorNode = mode === "notes" && notesView === "canvas" ? selectedNode : overviewSelectedNode;
  const inspectorEl = (
    <WorkspaceInspector
      node={inspectorNode}
      collapsed={panes.inspectorCollapsed}
      noHeadings={!(mode === "notes" && notesView === "editor")}
      nav={focus}
      setMode={setMode}
      refresh={refresh}
      onOpenFullRelations={(id) => { setGraphFocus(id); setMode("graph"); }}
      onShowContent={displayedMobileTab === "info" ? closeInfo : undefined}
      onRunNoteCommand={modules.runNoteCommand}
    />
  );
  const sidebarEl = (
    <WorkspaceSidebar
      drag={sidebarDrag}
      rename={{ renamingNodeId, setRenamingNodeId, renameDraft, setRenameDraft }}
      lifecycle={lifecycle}
      creation={creation}
      nav={{ openNote, openTag }}
      onCreateTag={createTagFromSidebar}
    />
  );

  const boardEl = (
    <KnowledgeWorkspace
      board={board.board}
      actions={board.actions}
      mobileView={mobileView}
      onScreen={mobileView === "graph" && displayedMobileTab === "edit"}
      onClickWikilink={(label, fromId) => void overview.openWikilink(label, null, fromId)}
    />
  );

  const fullPage = pageLayout(mode) === "full";
  // Each column's switch sits at its own side of the top bar (decisions-ui.md):
  // the info panel's is the right end, a toggle for the pane beside the note,
  // absent on a full page. Phone: the one way to Info from the note page (what
  // the Info tab does) stays in the note header; the screen replaces the note,
  // so the button is never "pressed" while it can be tapped.
  const showInfo = () => { setOverviewMobileTab("info"); panes.showInspector(); };
  const phoneInfoButton = phoneLayout ? { pressed: false, onToggle: showInfo } : undefined;
  const noteActionsWired = { ...noteActions, inspectorToggle: phoneInfoButton, runNoteCommand: modules.runNoteCommand };
  const inspectorToggle = phoneLayout || fullPage ? undefined : { pressed: panes.inspectorVisible, onToggle: panes.toggleInspector };
  const sidebarToggle = phoneLayout || fullPage ? undefined : { pressed: panes.sidebarVisible, onToggle: panes.toggleSidebar };
  const inspectorShown = !fullPage && !splitOn && panes.inspectorOpen && !!selectedNode && panes.showsSelection;

  // Ctrl/⌘ + click on a link opens it on the other side; a plain click opens it where it was clicked.
  const centerFocus = {
    ...focus,
    followLink: (id: string) => { if (splitView.modClick()) splitView.openBeside(id, "left"); else focus.followLink(id); },
  };
  const centerOverview = {
    ...overview,
    openWikilink: (label: string, targetId?: string | null, fromId?: string, blockId?: string) => {
      if (splitView.modClick()) {
        const id = targetId ?? resolveWikilink(label, selectedNode ? { id: selectedNode.id, space_id: selectedNode.space_id } : null, data.nodes)?.id;
        if (id) { splitView.openBeside(id, "left"); return Promise.resolve(); }
      }
      return overview.openWikilink(label, targetId, fromId, blockId);
    },
  };
  // A function page (tasks, history…) on the left that has a note on its right opens notes THERE, so the page stays.
  const rightIsNote = splitOn && split.right?.kind === "note";

  // The right side: the same components as the left (components/splitView/SplitPane).
  const rightPane = split.right && (
    <SplitPane
      target={split.right}
      outlet={{ refresh, dueSoon, openModule }}
      onOpenNoteLeft={(id) => splitView.openBeside(id, "right")}
      onChangeTarget={(target) => splitView.openRight(target)}
      onSwap={splitView.swap}
      onClose={splitView.closeRight}
      refresh={refresh}
    />
  );
  // 「放進另一邊」: the note on the other side, when that side shows a note's text.
  const textNote = (target: typeof split.right) => {
    if (!target || target.kind !== "note" || target.tab !== "content") return null;
    const found = nodeOf(data, target.id);
    const note = isNote(found) ? found : undefined;
    return note ? { id: note.id, title: note.title } : null;
  };
  // Not the same note (並排: its text on both sides) — a quote never goes back into itself.
  const otherNote = (from: "left" | "right") => {
    const other = textNote(from === "left" ? split.right : splitView.left);
    return other && other.id !== textNote(from === "left" ? splitView.left : split.right)?.id ? other : null;
  };
  const quoteSource = (from: "left" | "right") => {
    const note = textNote(from === "left" ? splitView.left : split.right);
    return note ? { title: note.title, url: noteAddress(note.id) } : null;
  };

  return (
    <DecisionsProvider inbox={inbox.sidebarInbox}>
    <main className={classNames("app-shell", isModuleScreen(mode) && modules.moduleImmersive && "rss-reading")}>
      {accessRevoked ? <AccessRevokedNotice /> : membershipGated && <MembershipGate onRetry={sync} />}
      {!accessRevoked && <GateTypingBuffer active={membershipGated} />}
      <DeviceNotices />
      <FocusTopMark />
      <div ref={splitRootRef} className={classNames("split-root", splitOn && "split-root--on")} style={splitOn ? { "--split-ratio": split.ratio } as CSSProperties : undefined}>
      <div className="split-left" data-split-side="left">
      <section
        // Step D: while the membership gate is up, the workspace under the scrim
        // is inert + hidden from assistive tech — keyboard focus and screen
        // readers can't reach possibly-restricted content (the opaque scrim only
        // hides it visually).
        inert={membershipGated || accessRevoked || undefined}
        aria-hidden={membershipGated || accessRevoked || undefined}
        className={classNames(
        "workspace-grid",
        inspectorShown && "inspector-open",
        inspectorShown && panes.inspectorCollapsed && "inspector-collapsed",
        // A module screen is a full page; `module-screen-<id>` lets its own
        // CSS adjust the page (the site studio's phone height).
        fullPage && "full-page",
        (panes.sidebarCollapsed || splitOn) && "sidebar-collapsed",
        isModuleScreen(mode) && `module-screen-${mode}`,
      )}>
        <AppTopbar
          {...shellNav}
          onOpenPalette={openPalette}
          sidebarToggle={sidebarToggle}
          inspectorToggle={inspectorToggle}
        />
        {mode === "notes" ? (
          <NotesWorkspace
            sidebar={sidebarEl}
            inspector={inspectorEl}
            mobileTab={displayedMobileTab}
            ui={uiMode}
            onCloseInfo={closeInfo}
            nav={focus}
            panes={splitOn ? { ...panes, sidebarCollapsed: true } : panes}
            welcomeActions={{ refresh, createNote, openDailyNote }}
            noteActions={noteActionsWired}
            nodeVersions={overview.nodeVersions}
            onAssignGroup={nodeActions.assignToGroup}
            center={
              <NotesCenter
                notesView={notesView}
                viewTab={viewTab}
                board={boardEl}
                focus={centerFocus}
                overview={centerOverview}
                noteActions={noteActionsWired}
                openDailyNote={openDailyNote}
                createNote={createNote}
                setTodayMood={dayWrites.setTodayMood}
                openModule={openModule}
                canvasImported={canvasImported}
                refresh={refresh}
                openTagsOverview={uiMode.showTags}
              />
            }
          />
        ) : (
          // doc 01 P1 — every other lens gets the same left sidebar (col-1) so a
          // node can be navigated/focused in place without ejecting to notes.
          <>
            {/* Module screens (site studio, reader, review) and History are
                full-width pages — no note-list sidebar beside them. */}
            {!fullPage && sidebarEl}
            <SecondaryLensOutlet
              mode={mode}
              refresh={refresh}
              onOpenNote={(id) => (rightIsNote ? splitView.openBeside(id, "left") : openNote(id))}
              onOpenNoteFromAgenda={(id) => (rightIsNote ? splitView.openBeside(id, "left") : followLink(id))}
              dueSoon={dueSoon}
              openModule={openModule}
              moduleTarget={modules.moduleTarget}
              onImmersiveChange={modules.setModuleImmersive}
            />
          </>
        )}

        {/* doc 09 — the ONE inspector follows the focused node across every lens.
            In notes mode it renders inside the obsidian inner grid (above); in
            every other lens it renders here as the workspace-grid col-3 sibling.
            Mutually exclusive by mode, so the same element never double-mounts. */}
        {mode !== "notes" && !fullPage && panes.showsSelection && inspectorEl}
        <SideDrawers
          eventsOpen={eventsOpen}
          onCloseEvents={() => setEventsOpen(false)}
          mobileView={mobileView}
          events={data.events}
        />
      </section>
      </div>
      {splitOn && split.right && (
        <>
          <SplitDivider ratio={split.ratio || SPLIT_RATIO_DEFAULT} container={() => splitRootRef.current} />
          <Suspense fallback={<aside className="split-pane" />}>{rightPane}</Suspense>
        </>
      )}
      <SplitDropHint />
      <QuoteToOther active={!splitView.phone && split.right !== null} otherNote={otherNote} sourceOf={quoteSource} />
      </div>

      {cardAudienceOpen && <Suspense fallback={null}><BoardCardAudienceConfirm /></Suspense>}

      {ctxMenu && (
        <Suspense fallback={null}>
          <WorkspaceContextMenu
            menu={ctxMenu}
            onClose={() => setCtxMenu(null)}
            openNote={openNote}
            rename={menus}
            creation={creation}
            board={board}
          />
        </Suspense>
      )}

      <MobileNav
        mode={mode}
        setMode={setMode}
        onSyncNow={sync}
        onOpenNote={openNote}
        onCapture={openQuickCapture}
        onOpenFeature={modules.openFeature}
        onOpenModule={openModuleScreen}
      />

      <WorkspaceOverlays
        palette={palette}
        settings={settings}
        sharedDraft={sharedDraft}
        openCapture={openCapture}
        create={create}
        onOpenTag={openTag}
        onOpenNote={openNote}
        refresh={refresh}
      />
    </main>
    </DecisionsProvider>
  );
}

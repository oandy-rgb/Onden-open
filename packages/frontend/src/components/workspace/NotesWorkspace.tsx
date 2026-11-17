import { Suspense, useEffect, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { setSelectedId, useOnline, useAllNodes } from "../../lib/appStore";
import { t } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import type { OverviewMobileTab, useUiMode } from "../../hooks/useUiMode";
import { useWelcomeBanner } from "../../hooks/useWelcomeBanner";
import type { useWorkspaceFocus } from "../../hooks/useWorkspaceFocus";
import type { useWorkspacePanes } from "../../hooks/useWorkspacePanes";
import { markBackNavigation } from "../../lib/pageScrollRestore";
import { goBackInApp, navigate } from "../../hooks/useUrlLocation";
import { ViewTabs, ViewStripBar, ViewStripProvider, useViewOwner, useViewStripHost } from "../viewTabs";
import { useIsMobile } from "../../hooks/useIsMobile";
import { activeTabKey } from "../../lib/viewTabs";
import { requestTagFields } from "../../lib/tagPageRequest";
import { useCapabilities } from "../../lib/capabilities";
import { useNoteTitleScrolledPast } from "../../lib/noteTitleVisibility";
import RegionErrorBoundary from "../RegionErrorBoundary";
import PhoneNoteLocation from "../PhoneNoteLocation";
import { NoteTabActions, type NoteActionsWiring } from "../WiredNoteActions";
import type { NodeVersion } from "../NoteVersionHistory";
import { setBodyClass } from "../../lib/documentAccess";
import { Pressable } from "../ui";
import { BoardPhoneNavProvider, type BoardPhoneNavValue } from "../BoardPhoneNav";
import { displayTitle } from "../../lib/noteLabel";
import { useAiEnabled } from "../../hooks/useModuleFilter";
import NotePhoneAiHost from "../NotePhoneAiHost";
import { isNote } from "@onden/markdown/contract";

const WelcomeBanner = lazyWithReload(() => import("../WelcomeBanner"));

type Props = {
  /** The note list (left), the focused node's lens (center), the inspector (right). */
  sidebar: ReactNode;
  center: ReactNode;
  inspector: ReactNode;
  /** The phone's drill level: the list, or the open note's content / info. */
  mobileTab: OverviewMobileTab;
  ui: Pick<ReturnType<typeof useUiMode>, "mode" | "setMode" | "notesView" | "setNotesView" | "viewTab" | "setOverviewMobileTab">;
  /** The phone's Info screen back to the note's content; also drops the history entry that screen holds. */
  onCloseInfo: () => void;
  nav: Partial<Pick<ReturnType<typeof useWorkspaceFocus>, "followLink">> & Pick<ReturnType<typeof useWorkspaceFocus>, "goBack" | "canGoBack" | "setLens" | "selectTab" | "openBoardId" | "selectedNode" | "selectedTag" | "pageNode" | "pageTag">;
  panes: Pick<ReturnType<typeof useWorkspacePanes>, "inspectorOpen" | "focusMode" | "showInspector"> & Partial<Pick<ReturnType<typeof useWorkspacePanes>, "sidebarCollapsed">>;
  /** The open note's ⋯ wiring and saved versions: the top bar carries ⊟ ＋ ⋯ over the tabs that have no editor header. */
  noteActions: NoteActionsWiring;
  nodeVersions: NodeVersion[];
  /** Move a note under another (null = top level), from the phone top bar's location. */
  onAssignGroup?: (nodeId: string, parentId: string | null) => unknown;
  /** First-run welcome card actions. */
  welcomeActions: { refresh: () => Promise<void>; createNote: () => Promise<unknown>; openDailyNote: () => Promise<unknown> };
};

/** The notes list is a page: `history` says whether leaving the note is a new page (the location's 筆記) or only
 *  the way out of a window with nothing behind it. */
function showNotesList(setOverviewMobileTab: (tab: OverviewMobileTab) => void, history: "push" | "replace") {
  markBackNavigation();
  navigate(() => { setSelectedId(null); setOverviewMobileTab("list"); }, { history });
}

/** The phone's step back out of an open note: the note's top bar and a full-screen board's ‹ do the same thing. */
function usePhoneBack({ mobileTab, ui, nav, onCloseInfo }: Pick<Props, "mobileTab" | "ui" | "nav" | "onCloseInfo">) {
  const { setOverviewMobileTab } = ui;
  const { canGoBack, goBack } = nav;
  const infoOpen = mobileTab === "info";
  return {
    infoOpen,
    onBack: () => {
      if (infoOpen) onCloseInfo();
      else if (canGoBack) goBack();
      else goBackInApp(() => showNotesList(setOverviewMobileTab, "replace")); // on a phone the first entry is the list, so this fallback is only for a window without one
    },
    label: infoOpen ? t("Back to note") : canGoBack ? t("Back") : t("Back to notes list"),
  };
}

/** The notes home: the three-pane workspace around the focused note. */
export default function NotesWorkspace({ sidebar, center, inspector, mobileTab, ui, onCloseInfo, nav, panes, welcomeActions, noteActions, nodeVersions, onAssignGroup }: Props) {
  const { setMode, notesView, setNotesView, viewTab } = ui;
  const viewOwner = useViewOwner(nav.pageNode, nav.pageTag);
  const online = useOnline();
  const welcome = useWelcomeBanner({ refresh: welcomeActions.refresh, setMode, setNotesView });
  // Mobile Option A (mobile-nav-two-axis): drilling into a note collapses the
  // two stacked top bars into ONE contextual bar. Flag that state on <body> so
  // CSS (gated to ≤900px) can hide the brand app-topbar and float the
  // .overview-mobile-tabs strip to the top — the list level keeps the brand bar.
  // Eliminating the second fixed/sticky bar also removes the fixed-vs-sticky
  // desync some phones showed. Leaving the notes home removes the flag.
  useEffect(() => {
    setBodyClass("onden-note-detail", mobileTab !== "list");
    return () => setBodyClass("onden-note-detail", false);
  }, [mobileTab]);
  const activeKey = activeTabKey({ lens: notesView, viewTab });
  const focusKeys = [nav.selectedNode?.id, nav.selectedTag?.id];
  // The page's title strip (ViewStrip): on a wide screen, a full-width row over the page's tabs. A phone draws the
  // same ViewTabs as a row inside the page, above the title (it scrolls away with it); only a phone's full-screen
  // board has no title to sit above, so it keeps the title sheet (BoardPhoneNav).
  const phone = useIsMobile();
  const aiOn = useAiEnabled();
  const stripShown = !phone && (!!viewOwner || nav.openBoardId !== null || notesView === "canvas");
  const phoneBoard = nav.openBoardId !== null || notesView === "canvas";
  const phoneTabsShown = phone && !!viewOwner && mobileTab === "edit" && !phoneBoard;
  const strip = useViewStripHost(stripShown);
  const back = usePhoneBack({ mobileTab, ui, nav, onCloseInfo });
  // The full-screen board hides the bars above; it carries ‹ and the page's title sheet itself, so the sheet also
  // holds the note's ⊟ ⋯ (the top bar that has them is hidden there). A tag's whiteboard gets the same sheet with
  // the tag's tabs: without it a phone had no way from a tag's board back to its other tabs.
  const boardNote = nav.pageTag ? null : nav.pageNode;
  const boardNav: BoardPhoneNavValue | null = viewOwner && (nav.pageTag || boardNote) ? {
    back: { onBack: back.onBack, label: back.label },
    title: nav.pageTag ? `#${viewOwner.owner.name}` : displayTitle(boardNote!.title),
    sheet: (close) => (
      <div className="board-note-sheet__body">
        <div className="board-note-sheet__tabs">
          <ViewTabs owner={viewOwner.owner} activeKey={activeKey}
            earnsWhiteboard={viewOwner.hasBoard} retiredBoard={viewOwner.retiredBoard} canManage={viewOwner.canManage}
            fields={viewOwner.fields} onSelect={(key) => { close(); nav.selectTab(key); }} />
        </div>
        {boardNote && (
          <div className="board-note-sheet__actions">
            <NoteTabActions node={boardNote} wiring={noteActions} nodeVersions={nodeVersions} />
          </div>
        )}
      </div>
    ),
  } : null;
  return (
    <BoardPhoneNavProvider value={boardNav}>
    <ViewStripProvider value={strip.slots}>
    <section className={classNames("overview-workspace", "obsidian-workspace", !panes.inspectorOpen && "inspector-hidden", panes.focusMode && "focus-mode", panes.sidebarCollapsed && "sidebar-collapsed")} data-mobile-tab={mobileTab}>
      <NotesMobileTabs mobileTab={mobileTab} ui={ui} nav={nav} onAssignGroup={onAssignGroup} onCloseInfo={onCloseInfo} />
      {/* The editor's header carries ⊟ ⋯ on the content tab; every other tab of a
          note gets the same two buttons in the same place. The Info screen has none. */}
      {mobileTab === "edit" && nav.pageNode && !nav.pageTag && (notesView !== "editor" || viewTab || nav.openBoardId !== null) && (
        <NoteTabActions node={nav.pageNode} wiring={noteActions} nodeVersions={nodeVersions} />
      )}
      <RegionErrorBoundary region="sidebar" resetKeys={focusKeys}>{sidebar}</RegionErrorBoundary>
      <div className="notes-center-wrap">
        {/* The page's title strip: its view tabs (content, whiteboard, table…; ＋ adds one) at the left, the open tab's
            own buttons and the note's ⋯ at the right. Always there, so switching tabs or selecting a card never
            moves anything (docs/agents/decisions-ui.md, 筆記與標籤頁的視角分頁). */}
        {stripShown && (
          <ViewStripBar toolsRef={strip.toolsRef} moreRef={strip.moreRef}>
            {viewOwner && (
              <ViewTabs owner={viewOwner.owner} activeKey={activeKey}
                earnsWhiteboard={viewOwner.hasBoard} retiredBoard={viewOwner.retiredBoard} canManage={viewOwner.canManage}
                fields={viewOwner.fields} onSelect={nav.selectTab}
                onEditFields={nav.pageTag && viewOwner.canManage ? () => requestTagFields(nav.pageTag!.id) : undefined} />
            )}
          </ViewStripBar>
        )}
        {/* A phone: the same tabs as a row in the page, above its title; not fixed, so it leaves with the title. */}
        {phoneTabsShown && viewOwner && (
          <div className="phone-view-tabs">
            <ViewTabs owner={viewOwner.owner} activeKey={activeKey}
              earnsWhiteboard={viewOwner.hasBoard} retiredBoard={viewOwner.retiredBoard} canManage={viewOwner.canManage}
              fields={viewOwner.fields} onSelect={nav.selectTab}
              onEditFields={nav.pageTag && viewOwner.canManage ? () => requestTagFields(nav.pageTag!.id) : undefined} />
          </div>
        )}
        {(welcome.visible || welcome.languageOnly) && notesView === "editor" && !nav.selectedTag && (
          <Suspense fallback={null}>
            <WelcomeBanner
              onCreateNote={() => { welcome.dismiss(); void welcomeActions.createNote(); }}
              onOpenToday={() => { welcome.dismiss(); void welcomeActions.openDailyNote(); }}
              onInstallStarter={welcome.installStarterPack}
              onBuildSite={welcome.buildIntroSite}
              online={online}
              languageOnly={!welcome.visible}
              onDismiss={welcome.dismiss}
            />
          </Suspense>
        )}
        {/* The note's content, whiteboard and views are one region: a tab that throws leaves the tabs above it,
            the sidebar and the info panel working, and picking another tab or note clears the message. */}
        <RegionErrorBoundary region="center" resetKeys={[...focusKeys, notesView, viewTab, nav.openBoardId]}>{center}</RegionErrorBoundary>
      </div>
      <RegionErrorBoundary region="inspector" resetKeys={focusKeys}>{inspector}</RegionErrorBoundary>
      {/* The phone's AI: a bottom panel over the note, since the Info screen would replace it. */}
      {phone && aiOn && mobileTab === "edit" && nav.selectedNode?.node_type === "content" && !nav.selectedTag && (
        <NotePhoneAiHost node={nav.selectedNode} onSelectNode={nav.followLink ?? setSelectedId} />
      )}
    </section>
    </ViewStripProvider>
    </BoardPhoneNavProvider>
  );
}

/**
 * Two-axis mobile nav (mobile-nav-two-axis): the bottom bar switches MODE;
 * this top strip leads out of the current thing, as a two-level drill
 * (Apple Notes logic). At the list level it's just a browse title; opening a
 * note drills in and the strip becomes a back-affordance (the note's ⊟ ⋯ sit
 * at its right end, the same on every tab).
 */
function NotesMobileTabs({ mobileTab, ui, nav, onAssignGroup, onCloseInfo }: Pick<Props, "mobileTab" | "ui" | "nav" | "onAssignGroup" | "onCloseInfo">) {
  const { notesView, viewTab, setOverviewMobileTab } = ui;
  const back = usePhoneBack({ mobileTab, ui, nav, onCloseInfo });
  const online = useOnline();
  const nodes = useAllNodes();
  const canEdit = useCapabilities(online).canEdit;
  const titleScrolledPast = useNoteTitleScrolledPast();
  const node = nav.selectedNode;
  // The note's place sits in the bar's middle on its content tab; the other tabs put ⊟ ⋯ at the right end instead.
  const showLocation = !!node && isNote(node) && mobileTab === "edit" && notesView === "editor" && !viewTab && !nav.selectedTag;
  // The list level has no strip: the brand bar, the bottom nav and the list's
  // own tabs already say "Notes".
  if (mobileTab === "list") return null;
  return (
    <div className="overview-mobile-tabs" data-level="note">
      {/* Single layered back (the app-topbar's back-stack chevron is hidden
          with the topbar in this view): Info is a side screen of the open
          note, so ‹ returns to the tab it came from; otherwise pop the link
          trail (wikilink/backlink jumps) first, then fall back to the notes
          list — so flow-linkage back survives the merge. The page's own tabs
          are a row in the page under its title bar, not here; ⊟ ⋯ sit at this bar's right end. */}
      <Pressable
        className="omt-back"
        onClick={back.onBack}
        aria-label={back.label}
      >
        <ChevronLeft size={22} aria-hidden="true" />
        {back.infoOpen && <span>{t("Content")}</span>}
      </Pressable>
      {showLocation && (
        <PhoneNoteLocation node={node} nodes={nodes} canEdit={canEdit(node)}
          onOpenNote={setSelectedId} onAssignGroup={onAssignGroup} titleScrolledPast={titleScrolledPast}
          onOpenNotesList={() => showNotesList(setOverviewMobileTab, "push")} />
      )}
    </div>
  );
}

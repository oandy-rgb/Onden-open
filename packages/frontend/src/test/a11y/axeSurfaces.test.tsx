// axe-core over the app's main surfaces, rendered in jsdom with fixture data
// shaped like a real workspace (notes with tags and properties, a canvas, an
// RSS feed, inbox and history events). One axe run per surface; a broken rule
// is the id `surface: rule`. Known ones are in a11y/baseline.ts.
//
// What jsdom can and cannot judge: roles, names, labels, ARIA validity, duplicate
// ids, landmarks and form labels yes; colour contrast (see contrast.test.ts),
// focus order and real focus trapping no (a native <dialog> is stubbed in setup.ts).
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "../helpers/offlineNetwork";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolationIds } from "./axe";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", async (original) => ({ ...await original<typeof import("../../lib/api")>(), api: apiMock }));
vi.mock("../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u1", name: "Andy", email: "a@example.com" } } }), signOut: vi.fn() },
}));
vi.mock("../../lib/accountStorage", async (original) => ({ ...await original<typeof import("../../lib/accountStorage")>(), boundAccountId: () => "u1" }));
// sql.js never loads in jsdom: the search and the pending-writes queue answer empty.
vi.mock("../../lib/localDb", async (original) => ({
  ...await original<typeof import("../../lib/localDb")>(), searchNodes: vi.fn(async () => []), getPendingWrites: vi.fn(async () => []),
}));
vi.mock("../../hooks/useLiveEventLog", () => ({ useLiveEventLog: vi.fn() }));
// The history page reads the chart, the list of changes and the recently deleted notes.
vi.mock("../../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(), fetchFeed: vi.fn(), fetchDeleted: vi.fn(),
}));
// The settings widgets that fetch on their own are covered by their own tests.
vi.mock("../../settings/spacesAndMembers", () => ({ default: () => <div>spaces widget</div> }));
vi.mock("../../settings/ModulesSetting", () => ({ default: () => <div>modules widget</div> }));
// ReactFlow needs real layout; the canvas toolbar is KnowledgeWorkspace's own markup.
vi.mock("@xyflow/react", async (original) => ({ ...await original<typeof import("@xyflow/react")>(), ReactFlow: () => <div /> }));
vi.mock("../../components/CardNode", () => ({ CardNode: () => null }));
vi.mock("../../components/SectionNode", () => ({ SectionNode: () => null }));

import AppTopbar from "../../components/AppTopbar";
import MobileNav from "../../components/MobileNav";
import WorkspaceSidebar from "../../components/workspace/WorkspaceSidebar";
import CreateSheet from "../../components/CreateSheet";
import CommandPalette from "../../components/CommandPalette";
import type { PaletteItem } from "../../lib/paletteItem";
import { confirmDialog } from "../../components/ConfirmDialog";
import MoveToDialog from "../../components/MoveToDialog";
import OverviewEditor from "../../components/OverviewEditor";
import SchemaLens from "../../components/tagPage";
import SettingsModal from "../../settings/SettingsModal";
import InboxReview from "../../components/InboxReview";
import { NoteHistory, WorkspaceHistory } from "../../components/history";
import * as historyApi from "../../lib/history/workspaceHistoryApi";
import { activityFixture, feedFixture } from "../workspaceHistoryFixtures";
import RssReaderPanel from "../../modules/rss/RssReaderPanel";
import KnowledgeWorkspace from "../../components/KnowledgeWorkspace";
import HomeStart from "../../components/HomeStart";
import { useLiveEventLog } from "../../hooks/useLiveEventLog";
import type { InboxEvent } from "../../lib/api";
import { resetAppState, setAppState } from "../../lib/appStore";
import { setLocalePref } from "../../lib/i18n";
import { resetShortcuts } from "../../lib/shortcuts";
import { bindAccountStorage } from "../../lib/accountStorage";
import { clearPhoneLayout, setPhoneLayout } from "../phoneMedia";
import { AXE_BASELINE, guardAgainstNewViolations } from "./baseline";
import { fixtureData, fixtureNotes, fixtureTags } from "./fixtures";

// jsdom has no scrollIntoView (the sidebar scrolls the open note into view).
Element.prototype.scrollIntoView = vi.fn();

// ── One axe run per surface ─────────────────────────────────────────────────

interface Surface {
  name: string;
  phone?: boolean;
  /** Renders the surface and waits until it shows its content. */
  show: () => Promise<{ root?: Element } | void>;
  /** Checks axe has no rule for, as ids `surface: what`. */
  extra?: () => string[];
}

const noop = () => {};
const liveEvents = (events: unknown[]) => vi.mocked(useLiveEventLog).mockImplementation(() => ({
  events, loading: false, error: null, isLive: true, reload: vi.fn().mockResolvedValue(true),
}) as never);
const note = fixtureNotes[0];
const tag = fixtureTags[0];

const surfaces: Surface[] = [
  { name: "top bar (desktop)", async show() {
    render(<AppTopbar mode="notes" setMode={noop} onOpenModule={noop} onOpenFeature={noop} onOpenPalette={noop}
      onOpenMembers={noop} onOpenSettings={noop} />);
  } },
  { name: "top bar (phone)", phone: true, async show() {
    render(<AppTopbar mode="notes" setMode={noop} onOpenModule={noop} onOpenFeature={noop} onOpenPalette={noop}
      onOpenMembers={noop} onOpenSettings={noop} />);
  } },
  { name: "bottom navigation (phone)", phone: true, async show() {
    render(<MobileNav mode="notes" setMode={noop} onCapture={noop} onOpenFeature={noop} />);
  } },
  { name: "sidebar", async show() {
    render(<WorkspaceSidebar
      drag={{
        sbDragId: null, sbDropTarget: null, sbDropSpace: null, sbSpaceMove: null, cancelSpaceMove: () => {}, finishSpaceMove: async () => {}, nodeTitle: () => "", sbTagDropId: null, springHint: null, springOpened: new Set<string>(), springKept: new Set<string>(), sbDragOverlay: null, expandedGroups: new Set<string>(), setExpandedGroups: noop,
        onSbPointerDown: noop, consumeTouchContextMenu: () => false, onSbDragEnd: noop, performSidebarDrop: async () => {},
        toggleGroup: noop, expandAllGroups: noop, collapseAllGroups: noop,
      }}
      rename={{ renamingNodeId: null, setRenamingNodeId: noop, renameDraft: "", setRenameDraft: noop }}
      lifecycle={{ renameNode: async () => true, openCtxMenu: noop } as never}
      creation={{ create: async () => null } as never}
      nav={{ openNote: noop, openTag: noop }}
      onCreateTag={async () => {}} />);
  } },
  { name: "create sheet", async show() {
    render(<CreateSheet create={async () => null} request={{ kind: "note" }} presentation="sheet" popover={{} as never} onClose={noop} />);
    await screen.findByRole("radiogroup");
    return { root: document.body };
  } },
  { name: "command palette", async show() {
    const items: PaletteItem[] = [
      { kind: "node", id: "n1", title: note.title, hint: "draft", group: "Recent Notes" },
      { kind: "action", id: "a1", label: "Go to Overview", hint: "mode", group: "Navigate", run: noop },
    ];
    render(<CommandPalette open onClose={noop} query="" onQueryChange={noop} index={0} onIndexChange={noop} items={items}
      inputRef={createRef<HTMLInputElement>()} searching={false} onSelect={noop} />);
  } },
  { name: "confirm dialog", async show() {
    void confirmDialog("Delete this note?", { title: "Delete note", confirmLabel: "Delete", danger: true });
    await screen.findByRole("alertdialog", undefined, { timeout: 2_000 });
    return { root: document.body };
  } },
  { name: "move-to dialog", async show() {
    render(<MoveToDialog node={note} nodes={fixtureNotes} onPick={noop} onClose={noop} />);
    return { root: document.body };
  } },
  { name: "note editor", async show() {
    render(<OverviewEditor node={note} titleDraft={note.title} onTitleChange={noop} draft={note.markdown ?? ""} onDraftChange={noop}
      view="edit" setView={noop} saveStatus="saved" onSave={noop} online nodes={fixtureNotes}
      onOpenWikilink={noop} onCreateFirst={noop} onSelectNode={noop} />);
    await screen.findByRole("textbox", { name: "Note title" });
  } },
  { name: "tag page", async show() {
    render(<SchemaLens tag={tag} online canManage allTags={fixtureTags} nodes={fixtureNotes} />);
    await screen.findByRole("button", { name: "Pin tag" });
  } },
  { name: "settings (desktop)", async show() {
    render(<SettingsModal online onClose={noop} onImportDone={noop} onConnect={noop} />);
    await screen.findByRole("button", { name: /^Appearance/ });
    return { root: document.body };
  } },
  { name: "settings (phone)", phone: true, async show() {
    render(<SettingsModal online onClose={noop} onImportDone={noop} onConnect={noop} />);
    await screen.findByRole("heading", { name: "Settings" });
    return { root: document.body };
  } },
  { name: "inbox review", async show() {
    const event: InboxEvent = {
      id: "20", actor_type: "ai_agent", actor_id: "claude", actor_name: "Claude", event_type: "NODE_UPDATED", target_type: "node",
      target_id: note.id, payload: { title: note.title }, created_at: "2026-10-22T01:00:00Z", external: false, restorable: true, root_event_id: "20",
    };
    render(<InboxReview events={[event]} groups={[]} facets={{ by_actor: [{ actor_id: "claude", actor_name: "Claude", count: 1 }], by_type: [{ event_type: "NODE_UPDATED", count: 1 }] }}
      filters={{ actorId: null, eventType: null }} onFiltersChange={noop} busyId={null} online onApprove={noop} onReject={noop} onGroupDecide={noop} />);
  } },
  { name: "history page", async show() {
    vi.mocked(historyApi.fetchActivity).mockResolvedValue([]);
    vi.mocked(historyApi.fetchFeed).mockResolvedValue({ days: [], earlier_day: null });
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: [{ id: "gone", title: "Old plan", deleted_at: "2026-10-22T01:56:00Z", space_id: null, blank: false }], older_cursor: null });
    render(<WorkspaceHistory online onOpenNote={noop} />);
  } },
  { name: "history page, one day of changes", async show() {
    vi.mocked(historyApi.fetchActivity).mockResolvedValue(activityFixture());
    vi.mocked(historyApi.fetchFeed).mockResolvedValue(feedFixture());
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: [], older_cursor: null });
    render(<WorkspaceHistory online onOpenNote={noop} />);
    await screen.findAllByText("演算法");
    // a day without edits is a pressable bar too: its quiet line must pass as well
    fireEvent.click(screen.getAllByRole("button", { name: /^\d+\/\d+, 0 edits$/ })[0]!);
    await screen.findByText("No edits on this day.");
  } },
  { name: "history page, recently deleted", async show() {
    vi.mocked(historyApi.fetchFeed).mockResolvedValue({ days: [], earlier_day: null });
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: [
      { id: "gone", title: "Old plan", deleted_at: "2026-10-22T01:56:00Z", space_id: null, blank: false },
      { id: "empty", title: "", deleted_at: "2026-10-22T01:56:00Z", space_id: null, blank: true },
    ], older_cursor: null });
    render(<WorkspaceHistory online onOpenNote={noop} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Recently deleted" }));
    await screen.findByText("Old plan");
  } },
  { name: "version history dialog", async show() {
    render(<NoteHistory node={note} versions={[{ id: "v1", title: "Earlier title", markdown: "Earlier body", changed_at: "2026-09-12T00:00:00Z", actor_name: "Andy", actor_type: "user" }]}
      currentMarkdown={note.markdown ?? ""} nodes={fixtureNotes} online={false} onOpenNote={noop} onClose={noop} />);
    return { root: document.body };
  } },
  { name: "RSS reader", async show() {
    render(<RssReaderPanel online onOpenNode={noop} />);
    await screen.findByText("Example Feed");
  } },
  { name: "home start",
    async show() {
      setAppState((state) => ({ data: { ...state.data, workspace: { ...state.data.workspace, modules: ["daily"] } } }));
      render(<HomeStart homeNodeId={note.id} nodes={fixtureNotes} tasks={[]} pinnedTags={fixtureTags} allTags={fixtureTags}
        onOpenNode={noop} onOpenToday={noop} onOpenTagView={noop} onSetTodayMood={noop} />);
    },
    // A mood button shows only an emoji, which a screen reader reads as its
    // Unicode name ("neutral face"), and its title is in English: axe passes it.
    extra: () => [...document.querySelectorAll(".home-start-mood-btn")].some((b) => !b.getAttribute("aria-label"))
      ? ["home start: mood button without aria-label"] : [],
  },
  { name: "canvas toolbar", async show() {
    const unused = vi.fn();
    render(<KnowledgeWorkspace
      board={{ displayGraphNodes: [], displayGraphEdges: [], canvasSearch: "", graphLocalMode: false, showTagEdges: false,
        parentMode: false, setGraphLocalMode: unused, setCanvasSearch: unused, setParentMode: unused,
        display: { settings: {}, set: unused } }}
      actions={new Proxy({}, { get: () => unused }) as never}
      mobileView="graph" onClickWikilink={unused} />);
  } },
];

async function checkAll(): Promise<string[]> {
  prepare();
  const found: string[] = [];
  for (const surface of surfaces) {
    cleanup();
    setPhoneLayout(surface.phone === true);
    resetAppState({ data: fixtureData(), online: true, activeCanvas: { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [] } } });
    liveEvents([]);
    const shown = await surface.show();
    await act(async () => { await Promise.resolve(); });
    found.push(...await axeViolationIds(surface.name, shown?.root ?? document.body), ...surface.extra?.() ?? []);
    cleanup();
    document.body.innerHTML = "";
  }
  clearPhoneLayout();
  return found;
}

// The guard collects in beforeAll, which runs before any beforeEach: set up here.
function prepare() {
  localStorage.clear();
  setLocalePref("en");
  resetShortcuts();
  bindAccountStorage("a11y-account", "");
  apiMock.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) {
      return { sources: [{ id: "feed", title: "Example Feed", url: "https://example.com/feed.xml", fetch_interval_minutes: 60, last_fetched_at: null,
        last_error: null, auto_tag: null, embed: false, unseen: 2, created_at: "2026-10-01T00:00:00Z" }], total_unseen: 2, module_default: null };
    }
    if (path.startsWith("/api/rss/items")) return { items: [], next_cursor: null };
    if (path === "/api/tags") return [];
    return {};
  });
}

afterEach(() => { cleanup(); clearPhoneLayout(); });

describe("the axe harness", () => {
  it("reports a broken page, so a clean result means something", async () => {
    const { container } = render(<main><button><svg aria-hidden="true" /></button><img src="x.png" /></main>);
    expect((await axeViolationIds("probe", container)).sort()).toEqual(["probe: button-name", "probe: image-alt"]);
  });
});

guardAgainstNewViolations("main surfaces have no axe violations (WCAG 2.1 A/AA)", checkAll, AXE_BASELINE, 120_000);

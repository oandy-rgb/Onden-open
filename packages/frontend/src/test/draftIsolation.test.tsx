import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Profiler } from "react";
import OverviewSidebar from "../components/OverviewSidebar";
import { sidebarGroups } from "./fixtures/sidebarGroups";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, setOverviewPane, useAppSelector, getAppState } from "../lib/appStore";
import { typeIntoDraft, resetDraftForNode, __resetDraftStateForTests } from "../lib/data/draftActions";

// H4 regression: the whole point of the app store is that an editor keystroke
// (typeIntoDraft — exactly what OverviewEditorHost's
// onDraftChange does) re-renders ONLY draft subscribers. The sidebar is the
// canary: it subscribes to notes/inbox/tag slices, and before H4 every
// keystroke re-rendered it through BuilderApp.

vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  // The sidebar's useLiveEventLog expects { events } — give every poll an
  // empty page so post-test resolutions don't crash the component.
  return { ...mod, api: vi.fn(async () => ({ events: [], count: 0 })) };
});
vi.mock("../lib/localDb", () => ({
  searchNodes: vi.fn(async () => []),
  upsertNode: vi.fn(async () => null),
  addPendingWrite: vi.fn(async () => null),
}));

const makeNode = (id: string, title: string): ContentNode => ({
  id, title, slug: title.toLowerCase(), markdown: `# ${title}\n\nbody`,
  node_type: "content", source_type: "manual",
});

const sidebarProps = sidebarGroups();

/** Stands in for OverviewEditorHost — the intended draft subscriber. */
function DraftProbe() {
  const draft = useAppSelector((s) => s.overviewDraft);
  return <div data-testid="draft-probe">{draft}</div>;
}

describe("H4 keystroke isolation", () => {
  beforeEach(() => {
    __resetDraftStateForTests();
    resetAppState({
      data: { ...noWorkspaceData, nodes: [makeNode("a", "Alpha"), makeNode("b", "Beta")] },
      online: true,
      selectedId: "a",
    });
    resetDraftForNode(getAppState().data.nodes[0]!);
  });
  afterEach(() => {
    __resetDraftStateForTests();
    resetAppState();
  });

  it("a draft keystroke re-renders the draft subscriber but NOT the sidebar", () => {
    let sidebarCommits = 0;
    render(
      <>
        <Profiler id="sidebar" onRender={() => { sidebarCommits++; }}>
          <OverviewSidebar {...sidebarProps} />
        </Profiler>
        <DraftProbe />
      </>,
    );
    const baseline = sidebarCommits;

    // What OverviewEditorHost's onDraftChange does per keystroke.
    act(() => {
      typeIntoDraft(getAppState().selectedId!, { markdown: "# Alpha\n\nbody plus a keystroke" });
    });

    expect(screen.getByTestId("draft-probe").textContent).toContain("plus a keystroke");
    expect(sidebarCommits, "typing must not re-render the sidebar tree").toBe(baseline);
  });

  it("sanity: a sidebar-relevant store change DOES re-render the sidebar", () => {
    let sidebarCommits = 0;
    render(
      <Profiler id="sidebar" onRender={() => { sidebarCommits++; }}>
        <OverviewSidebar {...sidebarProps} />
      </Profiler>,
    );
    const baseline = sidebarCommits;
    act(() => { setOverviewPane("tags"); });
    expect(sidebarCommits, "the Profiler probe itself must be live").toBeGreaterThan(baseline);
  });
});

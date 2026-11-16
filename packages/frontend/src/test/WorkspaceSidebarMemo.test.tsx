// H4 re-render hygiene for the sidebar's groups (depth audit D4): BuilderApp
// re-renders often and hands WorkspaceSidebar fresh objects and fresh handler
// closures every time (inline nav/rename, useSidebarDrag's functions). The
// memoized OverviewSidebar must skip those renders, and still render when a
// value inside a group changes.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useState } from "react";
import { noWorkspaceData } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import WorkspaceSidebar from "../components/workspace/WorkspaceSidebar";

vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []) }));
// A part inside the memoized sidebar: it renders only when the sidebar does.
let partRenders = 0;
vi.mock("../components/SidebarTagTree", () => ({ default: () => { partRenders++; return null; } }));

let bump: () => void = () => {};
let rename: (id: string | null) => void = () => {};

function Shell() {
  const [, setTick] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  bump = () => setTick((n) => n + 1);
  rename = setRenaming;
  const expandedGroups = useState(() => new Set<string>())[0];
  const springOpened = useState(() => new Set<string>())[0];
  // What BuilderApp passes: new objects and new closures on every render.
  return (
    <WorkspaceSidebar
      drag={{
        sbDragId: null, sbDropTarget: null, sbDropSpace: null, sbSpaceMove: null, cancelSpaceMove: () => {}, finishSpaceMove: async () => {}, nodeTitle: () => "", sbTagDropId: null, springHint: null, springOpened, springKept: springOpened, sbDragOverlay: null, expandedGroups, setExpandedGroups: () => {},
        onSbPointerDown: () => {}, consumeTouchContextMenu: () => false, onSbDragEnd: () => {}, performSidebarDrop: async () => {},
        toggleGroup: () => {}, expandAllGroups: () => {}, collapseAllGroups: () => {},
      }}
      rename={{ renamingNodeId: renaming, setRenamingNodeId: setRenaming, renameDraft: "", setRenameDraft: () => {} }}
      lifecycle={{ renameNode: async () => true, openCtxMenu: () => {} } as never}
      creation={{ create: async () => null } as never}
      nav={{ openNote: () => {}, openTag: () => {} }}
      onCreateTag={async () => {}}
    />
  );
}

beforeEach(() => { partRenders = 0; resetAppState({ data: { ...noWorkspaceData, nodes: [] }, online: true }); });
afterEach(() => resetAppState());

describe("WorkspaceSidebar groups keep their identity", () => {
  it("a shell re-render with the same values doesn't re-render the sidebar", () => {
    render(<Shell />);
    const baseline = partRenders;
    expect(baseline).toBeGreaterThan(0);
    act(() => bump());
    act(() => bump());
    expect(partRenders).toBe(baseline);
  });

  it("a changed value inside a group does re-render it", () => {
    render(<Shell />);
    const baseline = partRenders;
    act(() => rename("n1"));
    expect(partRenders).toBeGreaterThan(baseline);
  });
});

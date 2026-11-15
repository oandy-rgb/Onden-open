import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import NotesWorkspace from "../components/workspace/NotesWorkspace";
import type { Bootstrap, ContentNode } from "../lib/api";
import { noWorkspaceData } from "../lib/api";
import { resetAppState, getAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { trackNoteTitle } from "../lib/noteTitleVisibility";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
const spacesNow = vi.hoisted(() => ({ spaces: [] as Array<{ id: string; name: string; kind: "personal" | "shared"; is_default: boolean }> }));
vi.mock("../lib/spaces", async (original) => ({ ...await original<typeof import("../lib/spaces")>(), useSpaces: () => ({ spaces: spacesNow.spaces, loaded: true }) }));

const node = (over: Partial<ContentNode>): ContentNode =>
  ({ id: "n", source_type: "manual", node_type: "content", title: "T", slug: "t", markdown: "", ...over } as ContentNode);

const top = node({ id: "top", title: "Projects" });
const meetings = node({ id: "mtg", title: "Meetings", parent_id: "top" });
const weekly = node({ id: "wk", title: "Weekly 10/29", parent_id: "mtg" });
const lone = node({ id: "lone", title: "Lone note" });

function renderBar(selected: ContentNode, extra: { canGoBack?: boolean; onAssignGroup?: () => void; setTab?: () => void; nodes?: ContentNode[] } = {}) {
  resetAppState({ data: { ...noWorkspaceData, nodes: extra.nodes ?? [top, meetings, weekly, lone] } as Bootstrap, bootstrapped: true, online: true });
  return render(
    <NotesWorkspace
      sidebar={null} center={<div />} inspector={null} mobileTab="edit" onCloseInfo={() => {}}
      ui={{ mode: "notes", setMode: vi.fn(), notesView: "editor", setNotesView: vi.fn(), viewTab: null, setOverviewMobileTab: extra.setTab ?? vi.fn() }}
      nav={{ goBack: vi.fn(), canGoBack: extra.canGoBack ?? false, setLens: vi.fn(), selectTab: vi.fn(), openBoardId: null, selectedNode: selected, selectedTag: null, pageNode: selected, pageTag: null }}
      panes={{ inspectorOpen: true, focusMode: false, showInspector: vi.fn() }}
      noteActions={{ exportNote: async () => true, copyMarkdown: async () => true, exportBusy: false }}
      nodeVersions={[]}
      onAssignGroup={extra.onAssignGroup}
      welcomeActions={{ refresh: async () => {}, createNote: async () => {}, openDailyNote: async () => {} }}
    />,
  );
}
const bar = (c: HTMLElement) => within(c.querySelector(".overview-mobile-tabs") as HTMLElement);

describe("phone note top bar: location", () => {
  beforeEach(() => { resetOwnerViews(); });
  afterEach(() => { trackNoteTitle(null); vi.unstubAllGlobals(); resetAppState(); spacesNow.spaces = []; });

  it("‹ is only an icon; its action and label are unchanged", () => {
    const setTab = vi.fn();
    const { container } = renderBar(weekly, { setTab });
    const back = bar(container).getByRole("button", { name: "Back to notes list" });
    expect(back.textContent).toBe("");
    expect(back.querySelector("svg")).not.toBeNull();
    fireEvent.click(back);
    expect(setTab).toHaveBeenCalledWith("list");
    expect(renderBar(weekly, { canGoBack: true }).container.querySelector(".omt-back")).toHaveAttribute("aria-label", "Back");
  });

  it("under a parent: shows the path; the sheet lists ancestors and opens one", () => {
    const { container } = renderBar(weekly, { onAssignGroup: vi.fn() });
    const trail = bar(container).getByRole("button", { name: /Where this note sits/ });
    expect(trail).toHaveTextContent(/^Projects ›Meetings$/);
    fireEvent.click(trail);
    const menu = screen.getByRole("menu", { name: "Where this note sits" });
    expect(within(menu).getByText("Weekly 10/29")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Projects" }));
    expect(getAppState().selectedId).toBe("top");
  });

  it("starts at the note's space once notes live in more than one space, as the sidebar groups them", () => {
    spacesNow.spaces = [{ id: "me", name: "", kind: "personal", is_default: false }, { id: "all", name: "", kind: "shared", is_default: true }];
    const inMe = (n: ContentNode) => ({ ...n, space_id: "me" });
    const nodes = [inMe(top), inMe(meetings), inMe(weekly), { ...lone, space_id: "all" }];
    const { container, unmount } = renderBar(inMe(meetings), { onAssignGroup: vi.fn(), nodes });
    const trail = bar(container).getByRole("button", { name: /Where this note sits/ });
    expect(trail).toHaveTextContent(/^Only me ›Projects$/);
    fireEvent.click(trail);
    expect(within(screen.getByRole("menu", { name: "Where this note sits" })).getAllByRole("menuitem")[0]).toHaveTextContent("Only me");
    unmount();
    // One space with notes: the sidebar has no space headings, nor does the path.
    const single = renderBar(inMe(meetings), { onAssignGroup: vi.fn(), nodes: nodes.slice(0, 3) });
    expect(bar(single.container).getByRole("button", { name: /Where this note sits/ })).toHaveTextContent(/^Projects$/);
  });

  it("starts at the top note, with no app name in front", () => {
    const { container } = renderBar(meetings, { onAssignGroup: vi.fn() });
    const trail = bar(container).getByRole("button", { name: /Where this note sits/ });
    expect(trail).toHaveTextContent(/^Projects$/);
    expect(trail.querySelector(".pnl-far")).toBeNull();
  });

  it("‘Move elsewhere…’ opens the parent picker and moves the note", () => {
    const onAssignGroup = vi.fn();
    const { container } = renderBar(weekly, { onAssignGroup });
    fireEvent.click(bar(container).getByRole("button", { name: /Where this note sits/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move elsewhere…" }));
    const input = screen.getByRole("combobox", { name: "Search parent notes…" });
    expect(input).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Projects" }));
    expect(onAssignGroup).toHaveBeenCalledWith("wk", "top");
  });

  it("a viewer gets no ‘Move elsewhere…’", () => {
    const { container } = renderBar(weekly);
    fireEvent.click(bar(container).getByRole("button", { name: /Where this note sits/ }));
    expect(screen.queryByRole("menuitem", { name: "Move elsewhere…" })).toBeNull();
  });

  it("top level: ‘Put under…’ opens the picker; a viewer sees nothing", () => {
    const { container, unmount } = renderBar(lone, { onAssignGroup: vi.fn() });
    fireEvent.click(bar(container).getByRole("button", { name: "Put under…" }));
    expect(screen.getByRole("combobox", { name: "Search parent notes…" })).toBeInTheDocument();
    unmount();
    const viewer = renderBar(lone);
    expect(bar(viewer.container).queryByRole("button", { name: "Put under…" })).toBeNull();
    expect(viewer.container.querySelector(".pnl")).toBeNull();
  });

  it("once the title is covered, the bar shows path and title", () => {
    let callback: IntersectionObserverCallback = () => {};
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) { callback = cb; }
      observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
    });
    const { container } = renderBar(weekly, { onAssignGroup: vi.fn() });
    trackNoteTitle(document.createElement("input"));
    act(() => callback([{ isIntersecting: false, boundingClientRect: { bottom: 10 } } as IntersectionObserverEntry], {} as IntersectionObserver));
    const trail = bar(container).getByRole("button", { name: /Where this note sits/ });
    expect(trail).toHaveTextContent("Weekly 10/29");
    expect(trail.querySelector(".pnl-small")).toHaveTextContent(/^Projects › Meetings$/);
  });
});

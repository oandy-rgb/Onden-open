import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import NotesWorkspace from "../components/workspace/NotesWorkspace";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import type { OverviewMobileTab } from "../hooks/useUiMode";

// The phone's note top bar has no Info tab; the header's Info button
// switches the mobile tab to "info" (BuilderWorkspace.showInfo). On that screen the strip's
// ‹ returns to the note's content, not to the notes list.

const note: ContentNode = {
  id: "n1", title: "N1", slug: "n1", markdown: "# A", node_type: "content", source_type: "manual", updated_at: "2026-10-01T00:00:00Z",
};

function setup(mobileTab: OverviewMobileTab, notesView: "editor" | "canvas" = "editor", viewTab: string | null = null) {
  const ui = { mode: "notes", setMode: vi.fn(), notesView, setNotesView: vi.fn(), viewTab, setOverviewMobileTab: vi.fn() };
  const nav = { goBack: vi.fn(), canGoBack: false, setLens: vi.fn(), selectTab: vi.fn(), openBoardId: null, selectedNode: note, selectedTag: null };
  const onCloseInfo = vi.fn();
  const panes = { inspectorOpen: true, focusMode: false, showInspector: vi.fn() };
  render(
    <NotesWorkspace
      sidebar={<div>sidebar</div>}
      center={<div>center</div>}
      inspector={<aside>inspector</aside>}
      mobileTab={mobileTab}
      onCloseInfo={onCloseInfo}
      ui={ui as never}
      nav={nav as never}
      panes={panes}
      noteActions={{ exportNote: async () => true, copyMarkdown: async () => true, exportBusy: false }}
      nodeVersions={[]}
      welcomeActions={{ refresh: vi.fn(), createNote: vi.fn(), openDailyNote: vi.fn() }}
    />,
  );
  return { ui, nav, panes, onCloseInfo };
}

beforeEach(() => {
  localStorage.clear();
  resetAppState({ data: { ...noWorkspaceData, nodes: [note] }, online: true });
  act(() => setLocalePref("en"));
});
afterEach(() => { cleanup(); resetAppState(); act(() => setLocalePref("system")); });

describe("phone Info screen over a note page", () => {
  it("marks the workspace as the info level so the inspector shows", () => {
    setup("info");
    expect(document.querySelector(".overview-workspace")?.getAttribute("data-mobile-tab")).toBe("info");
    expect(screen.getByText("inspector")).toBeTruthy();
  });

  it("‹ returns to the note's content, not the notes list", () => {
    const { ui, nav, onCloseInfo } = setup("info");
    fireEvent.click(screen.getByRole("button", { name: "Back to note" }));
    expect(onCloseInfo).toHaveBeenCalledTimes(1); // BuilderWorkspace's closeInfo: drops the Info history entry, then shows the content
    expect(ui.setOverviewMobileTab).not.toHaveBeenCalledWith("list");
    expect(nav.goBack).not.toHaveBeenCalled();
  });

  it("the plain note page's strip is only ‹: no Info tab of its own", () => {
    setup("info");
    expect(screen.queryByRole("button", { name: "Info" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Note" })).toBeNull();
  });

  it("on the plain content page ‹ still goes to the list, with no extra tabs", () => {
    const { ui } = setup("edit");
    expect(screen.queryByRole("button", { name: "Info" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to notes list" }));
    expect(ui.setOverviewMobileTab).toHaveBeenCalledWith("list");
  });

  it("from a non-editor tab ‹ also returns to that tab's note screen, not the list", () => {
    const { ui, onCloseInfo } = setup("info", "canvas");
    fireEvent.click(screen.getByRole("button", { name: "Back to note" }));
    expect(onCloseInfo).toHaveBeenCalledTimes(1);
    expect(ui.setOverviewMobileTab).not.toHaveBeenCalledWith("list");
  });
});

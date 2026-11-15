import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppNavigation } from "../components/AppTopbar";
import SecondaryLensOutlet from "../components/SecondaryLensOutlet";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { defaultNavLayout, resolveNavLayout } from "../lib/navLayout";

// 歷史 is not in the default nav: it opens from 更多 ▾ and switches
// to the "timeline" view (WorkspaceHistory: the 14-day activity chart). Someone
// who pinned it keeps it in the bar.
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("../components/history", () => ({ WorkspaceHistory: () => <div data-testid="timeline-view">workspace history</div> }));

describe("History destination", () => {
  it("opens the timeline view, which renders WorkspaceHistory", async () => {
    resetAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, modules: [] } } });
    const setMode = vi.fn();
    render(<AppNavigation mode="notes" setMode={setMode} onOpenModule={vi.fn()} onOpenFeature={vi.fn()} />);
    expect(within(screen.getByRole("navigation", { name: "Primary" })).queryByRole("button", { name: "Workspace changes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Workspace changes" }));
    expect(setMode).toHaveBeenCalledWith("timeline");

    const noop = vi.fn();
    render(<SecondaryLensOutlet mode="timeline" refresh={async () => {}} onOpenNote={noop} onOpenNoteFromAgenda={noop}
      dueSoon={{ permission: "default", requestPermission: noop } as never} openModule={noop}
      moduleTarget={null} onImmersiveChange={noop} />);
    expect(await screen.findByTestId("timeline-view")).toBeInTheDocument();
    // One title, no subtitle repeating it and no "this note / everything" switch.
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.queryByText("Activity across your workspace")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Everything" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "This note" })).toBeNull();
  });

  it("keeps it in the bar for someone who pinned it", () => {
    expect(resolveNavLayout({ order: ["timeline", "tasks"], phone: 1 }, ["tasks", "graph", "timeline"]).order).toEqual(["timeline", "tasks"]);
    expect(defaultNavLayout(["tasks", "graph", "timeline"]).order).toEqual(["tasks", "graph"]);
  });
});

// The task page lists every visible task; with two or more spaces a filter
// narrows it to one space (a task is in its own space, else its note's).
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async () => ({}), upsertTask: vi.fn(async () => {}), removeTask: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(async () => null), upsertAttribute: vi.fn(async () => null),
}));

import "../modules";
import AppTopbar from "../components/AppTopbar";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";
import TasksMode from "../modules/tasks/TasksMode";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { setAppState } from "../lib/appStore";
import { reads } from "../lib/data";
import { refreshSpaces, resetSpacesForTest, type Space } from "../lib/spaces";
import type { TaskRow } from "../lib/tasks/taskModel";

const space = (id: string, name: string, over: Partial<Space> = {}): Space => ({
  id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...over,
});
const PERSONAL = space("sp-me", "me", { kind: "personal" });
const SHARED = space("sp-shared", "Club");
const note = (id: string, title: string, space_id: string) =>
  ({ id, title, slug: id, markdown: "", source_type: "manual", node_type: "content", space_id }) as ContentNode;
const TASKS: TaskRow[] = [
  { id: "a", node_id: "mine", title: "我的事", status: "todo" },
  { id: "b", node_id: "club", title: "社團的事", status: "todo" },
  { id: "c", node_id: null, title: "自己空間的事", status: "todo", space_id: "sp-shared" } as TaskRow,
];

function setup() {
  setAppState({ data: { ...noWorkspaceData, nodes: [note("mine", "Mine", "sp-me"), note("club", "Roadmap", "sp-shared")], tasks: TASKS as never } });
  render(<TasksMode online onSelectNode={() => {}} onRefresh={() => {}} onError={() => {}} reminderPermission="unsupported" onEnableReminders={() => {}} />);
  fireEvent.click(screen.getByRole("tab", { name: /Anytime/ }));
}
async function loadSpaces(spaces: Space[]) {
  vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces } as never);
  await refreshSpaces();
}

beforeEach(() => { bindAccountStorage("tasks-space-filter", ""); resetSpacesForTest(); });
afterEach(() => { vi.restoreAllMocks(); resetSpacesForTest(); clearPhoneLayout(); });

describe("task page space filter", () => {
  it("is not shown with one space, and lists everything", async () => {
    await loadSpaces([PERSONAL]);
    setup();
    expect(screen.queryByRole("button", { name: /All spaces/ })).toBeNull();
    expect(screen.getAllByText(/的事/)).toHaveLength(3);
  });

  it("lists every task by default and narrows to one space on choice", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    setup();
    const filter = await screen.findByRole("button", { name: /All spaces/ });
    expect(screen.getAllByText(/的事/)).toHaveLength(3);
    fireEvent.click(filter);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Club" }));
    await waitFor(() => expect(screen.getAllByText(/的事/)).toHaveLength(2));
    expect(screen.queryByText("我的事")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Club/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "All spaces" }));
    await waitFor(() => expect(screen.getAllByText(/的事/)).toHaveLength(3));
  });
});

describe("task page space filter on a phone", () => {
  function setupPhone() {
    setPhoneLayout(true);
    setAppState({ data: { ...noWorkspaceData, nodes: [note("mine", "Mine", "sp-me"), note("club", "Roadmap", "sp-shared")], tasks: TASKS as never } });
    return render(<>
      <AppTopbar mode="tasks" setMode={() => {}} onOpenModule={() => {}} onOpenFeature={() => {}} onOpenPalette={() => {}} onOpenMembers={() => {}} onOpenSettings={() => {}} />
      <TasksMode online onSelectNode={() => {}} onRefresh={() => {}} onError={() => {}} reminderPermission="unsupported" onEnableReminders={() => {}} />
    </>);
  }

  it("takes no row: an icon in the top bar, no header and no note until a space is chosen", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    const { container } = setupPhone();
    const button = await screen.findByRole("button", { name: "Filter by space" });
    expect(container.querySelector(".app-topbar")).toContainElement(button);
    expect(container.querySelector(".tasks-mode-header")).toBeNull();
    expect(container.querySelector(".space-filter-note")).toBeNull();
    expect(button.querySelector(".topbar-action-dot")).toBeNull();
  });

  it("is not offered with one space", async () => {
    await loadSpaces([PERSONAL]);
    setupPhone();
    expect(screen.queryByRole("button", { name: "Filter by space" })).toBeNull();
  });

  it("narrows, says so in a note, and the note clears it", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    const { container } = setupPhone();
    fireEvent.click(await screen.findByRole("button", { name: "Filter by space" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Club" }));
    const note = await waitFor(() => { const el = container.querySelector(".space-filter-note"); expect(el).not.toBeNull(); return el!; });
    expect(note).toHaveTextContent("Only: Club");
    expect(container.querySelector(".topbar-action-dot")).not.toBeNull();
    fireEvent.click(note.querySelector("button")!);
    await waitFor(() => expect(container.querySelector(".space-filter-note")).toBeNull());
    expect(container.querySelector(".topbar-action-dot")).toBeNull();
  });
});

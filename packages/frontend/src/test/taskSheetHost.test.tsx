// A link or embed of a task that is no note's line opens the task's own sheet (the one the Tasks
// page uses), through openTaskSheet and the shell's host; a task that is gone says so once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async () => ({}), upsertTask: vi.fn(async () => {}), removeTask: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(async () => null), upsertAttribute: vi.fn(async () => null),
}));

import { TaskSheetHost, openTaskSheet } from "../modules";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import type { TaskRow } from "../lib/tasks/taskModel";

const TASKS = [{ id: "solo", node_id: null, title: "Pay rent", status: "todo" }] as TaskRow[];

beforeEach(() => {
  bindAccountStorage("task-sheet-host", "");
  resetAppState();
  setAppState({ data: { ...noWorkspaceData, tasks: TASKS as never } });
});
afterEach(() => resetAppState());

function mount() {
  render(<TaskSheetHost online onSelectNode={() => {}} onRefresh={() => {}} onError={() => {}} />);
}

describe("TaskSheetHost", () => {
  it("opens the sheet of a task that is no note's line", async () => {
    mount();
    act(() => openTaskSheet("solo"));
    expect(await screen.findByDisplayValue("Pay rent")).toBeInTheDocument();
    expect(getAppState().toasts ?? []).toHaveLength(0);
  });

  it("opening a task to look at it does not put the cursor in its title (no keyboard over the sheet)", async () => {
    mount();
    act(() => openTaskSheet("solo"));
    const title = await screen.findByDisplayValue("Pay rent");
    expect(title).not.toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("opens the sheet of a task in another space (a link reaches it, so the sheet does)", async () => {
    setAppState({ data: { ...noWorkspaceData, tasks: [{ id: "far", node_id: null, title: "Club dues", status: "todo", space_id: "sp-other" }] as never } });
    mount();
    act(() => openTaskSheet("far"));
    expect(await screen.findByDisplayValue("Club dues")).toBeInTheDocument();
    expect(getAppState().toasts ?? []).toHaveLength(0);
  });

  it("says so once, and opens nothing, when the task cannot be found", async () => {
    mount();
    act(() => openTaskSheet("gone"));
    await waitFor(() => expect(getAppState().toasts).toHaveLength(1));
    expect(screen.queryByDisplayValue("Pay rent")).toBeNull();
  });
});

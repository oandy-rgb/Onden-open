// Quick-add's 「放在」: shown only with two or more writable spaces; starts on the
// open note's space, else the last one used, else the personal space; a pick
// goes to createQuickTask as `spaceId` (and `note` when a note was picked).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createQuickTask = vi.hoisted(() => vi.fn());
vi.mock("../modules/tasks/createQuickTask", () => ({ createQuickTask }));

import { QuickAddTask, openQuickAddTask } from "../modules/tasks";
import { defaultTaskSpace, lastTaskSpaceId, rememberTaskSpace } from "../modules/tasks/quickAddPlace";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { reads } from "../lib/data";
import { refreshSpaces, resetSpacesForTest, type Space } from "../lib/spaces";

const space = (id: string, name: string, over: Partial<Space> = {}): Space => ({
  id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...over,
});
const PERSONAL = space("sp-me", "me", { kind: "personal", can_manage: true });
const SHARED = space("sp-shared", "Club");
const READ_ONLY = space("sp-read", "Read only", { permission: "view" });
const note = (id: string, title: string, space_id: string): ContentNode =>
  ({ id, title, slug: id, markdown: "", source_type: "manual", node_type: "content", space_id }) as ContentNode;

bindAccountStorage("quick-add-place", "http://localhost");

async function loadSpaces(spaces: Space[]) {
  vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces } as never);
  await refreshSpaces();
}
async function openSheet() {
  render(<QuickAddTask />);
  act(() => openQuickAddTask());
  return screen.findByRole("combobox", { name: "Task" });
}
const placeButton = () => screen.queryByRole("button", { name: /^Put it in/ });

beforeEach(() => {
  resetSpacesForTest();
  rememberTaskSpace("");
  resetAppState({
    data: { ...noWorkspaceData, nodes: [note("roadmap", "Roadmap", "sp-shared"), note("mine", "Mine", "sp-me")], tags: [] },
    online: true,
  });
  createQuickTask.mockReset().mockResolvedValue({ saved: "saved", noteTitle: "任務" });
});
afterEach(() => { vi.restoreAllMocks(); resetSpacesForTest(); });

describe("defaultTaskSpace", () => {
  const spaces = [SHARED, READ_ONLY, PERSONAL];
  it("takes the open note's space, else the last one, else the personal space", () => {
    expect(defaultTaskSpace(spaces, "sp-shared", null)?.id).toBe("sp-shared");
    expect(defaultTaskSpace(spaces, null, "sp-shared")?.id).toBe("sp-shared");
    expect(defaultTaskSpace(spaces, "sp-me", "sp-shared")?.id).toBe("sp-me"); // the open note wins
    expect(defaultTaskSpace(spaces, null, null)?.id).toBe("sp-me");
  });
  it("skips a space that can't be written, or is gone", () => {
    expect(defaultTaskSpace(spaces, "sp-read", "sp-shared")?.id).toBe("sp-shared");
    expect(defaultTaskSpace(spaces, "sp-read", "sp-gone")?.id).toBe("sp-me");
  });
  it("offers no choice with fewer than two writable spaces", () => {
    expect(defaultTaskSpace([PERSONAL], null, null)).toBeNull();
    expect(defaultTaskSpace([PERSONAL, READ_ONLY], "sp-read", null)).toBeNull();
  });
});

describe("quick-add 放在", () => {
  it("is not there with one space, and the task carries no space", async () => {
    await loadSpaces([PERSONAL]);
    const box = await openSheet();
    expect(placeButton()).toBeNull();
    await userEvent.type(box, "交報告{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalled());
    expect(createQuickTask.mock.calls[0]![0].spaceId).toBeUndefined();
  });

  it("starts on the personal space, marked, with several spaces", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    await openSheet();
    await waitFor(() => expect(placeButton()).not.toBeNull());
    expect(placeButton()!.textContent).toBe("Put it inOnly me");
  });

  it("starts on the open note's space", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [note("roadmap", "Roadmap", "sp-shared")], tags: [] }, online: true, selectedId: "roadmap" });
    await loadSpaces([PERSONAL, SHARED]);
    await openSheet();
    await waitFor(() => expect(placeButton()?.textContent).toBe("Put it inClub"));
  });

  it("sends the picked shared space, remembers it, and names it in the added line", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    const box = await openSheet();
    await waitFor(() => expect(placeButton()).not.toBeNull());
    fireEvent.click(placeButton()!);
    const picker = await screen.findByRole("listbox");
    // Groups: Only me (top, Mine), Club (top, Roadmap) — Club's own top row is the space.
    const options = within(picker).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Default place for tasks", "Mine", "Default place for tasks", "Roadmap"]);
    fireEvent.click(options[2]!);
    await waitFor(() => expect(placeButton()?.textContent).toBe("Put it inClub"));
    await userEvent.type(await screen.findByRole("combobox", { name: "Task" }), "交報告{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalled());
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ spaceId: "sp-shared", note: null });
    expect(lastTaskSpaceId()).toBe("sp-shared");
    expect(await screen.findByText(/Club/, { selector: ".quick-add-added-place" })).toBeInTheDocument();
    void box;
  });

  it("sends a picked note along with its space", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    await openSheet();
    await waitFor(() => expect(placeButton()).not.toBeNull());
    fireEvent.click(placeButton()!);
    fireEvent.click(await screen.findByRole("option", { name: /Roadmap/ }));
    await userEvent.type(await screen.findByRole("combobox", { name: "Task" }), "交報告{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalled());
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ spaceId: "sp-shared", note: { id: "roadmap", title: "Roadmap" } });
  });

  it("starts on the space used last time", async () => {
    rememberTaskSpace("sp-shared");
    await loadSpaces([PERSONAL, SHARED]);
    await openSheet();
    await waitFor(() => expect(placeButton()?.textContent).toBe("Put it inClub"));
  });
});

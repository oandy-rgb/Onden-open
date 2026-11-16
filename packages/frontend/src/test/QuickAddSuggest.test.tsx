// Quick-add: the # / @ lists, the "did not understand this part" notice, and the readings added in 2026-11
// (a range, a part of the day, a length). The writer behind it (createQuickTask) is a spy.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createQuickTask = vi.hoisted(() => vi.fn());
vi.mock("../modules/tasks/createQuickTask", () => ({ createQuickTask }));
vi.mock("../lib/localDate", async (original) => ({
  ...await original<typeof import("../lib/localDate")>(),
  nowDateTimeId: () => "2026-11-02T03:20:00", // a Monday
  dayAndClock: () => ({ today: "2026-11-02", nowTime: "03:20" }),
}));

import { QuickAddTask, openQuickAddTask } from "../modules/tasks";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { reads } from "../lib/data";
import { suggestToken, applySuggestion } from "../modules/tasks/quickAddSuggest";
import { doubtfulRanges } from "../modules/tasks/quickAddTask";

const note = (id: string, title: string): ContentNode => ({ id, title, slug: id, markdown: "", node_type: "content", source_type: "manual", updated_at: `2026-11-0${id.length}` });
const tag = (id: string, name: string, over: Partial<Tag> = {}): Tag => ({ id, name, color: "", schema_id: null, ...over });

async function openSheet() {
  render(<QuickAddTask />);
  act(() => openQuickAddTask());
  return screen.findByRole("combobox", { name: "Task" });
}
const region = () => screen.getByRole("region", { name: "It will become" });
const chipsOf = () => within(region()).getAllByRole("listitem").map((li) => li.textContent);

beforeEach(() => {
  resetAppState({ data: { ...noWorkspaceData, nodes: [note("a", "Roadmap"), note("bb", "Reading list"), note("c", "My trip")], tags: [tag("t1", "school"), tag("t2", "schedule"), tag("t3", "work"), tag("t4", "hid", { hidden: true })] }, online: true });
  createQuickTask.mockReset().mockResolvedValue({ saved: "saved", noteTitle: "Roadmap" });
});
afterEach(() => vi.restoreAllMocks());

describe("suggestToken (pure)", () => {
  it("finds the # or @ word the caret is in, and not a sign inside a word", () => {
    expect(suggestToken("read #sc", 8)).toEqual({ trigger: "#", query: "sc", start: 5, end: 8 });
    expect(suggestToken("#", 1)).toEqual({ trigger: "#", query: "", start: 0, end: 1 });
    expect(suggestToken("note @Ro", 8)).toMatchObject({ trigger: "@", query: "Ro" });
    expect(suggestToken("mail me@home", 12)).toBeNull();
    expect(suggestToken("read #school more", 17)).toBeNull();
    // the rest of the word after the caret belongs to it
    expect(suggestToken("read #scXX more", 8)).toMatchObject({ query: "scXX", end: 10 });
  });
  it("choosing replaces the word and adds one space", () => {
    const token = suggestToken("read #sc more", 8)!;
    const item = { key: "t1", label: "#school", insert: "#school", note: null };
    expect(applySuggestion("read #sc more", token, item)).toEqual({ text: "read #school more", caret: 13 });
  });
});

describe("doubtfulRanges", () => {
  it("says where the pieces that were not understood sit in the title", () => {
    expect(doubtfulRanges("3點 開會", [{ text: "3點" }])).toEqual([[0, 2]]);
    expect(doubtfulRanges("開會 25:70", [{ text: "25:70" }, { text: "沒有" }])).toEqual([[3, 8]]);
    expect(doubtfulRanges("開會", [])).toEqual([]);
  });
});

describe("readings", () => {
  it("shows a range, a part of the day and a length as chips; the title keeps none of those words", async () => {
    const box = await openSheet();
    await userEvent.type(box, "週五下午 讀OS 30分鐘");
    expect(within(region()).getByText("讀OS")).toBeInTheDocument();
    expect(chipsOf()).toEqual(["11/6 (Fri)", "Afternoon", "30 min · no start time, not kept"]);
  });

  it("a range saves its end", async () => {
    const box = await openSheet();
    await userEvent.type(box, "明天 3點到5點 讀書{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ title: "讀書", when_date: "2026-11-03", time: "15:00", until: "17:00" });
  });
});

describe("a part that was not understood", () => {
  it("is marked in the title and explained, stops Add, and 'keep in title' lets it through", async () => {
    const box = await openSheet();
    await userEvent.type(box, "3點 開會");
    const notice = within(region()).getByRole("alert");
    expect(notice.textContent).toContain("3點");
    expect(region().querySelector("mark")?.textContent).toBe("3點");
    expect(screen.getByRole("button", { name: "Add it" })).toBeDisabled();
    await userEvent.type(box, "{Enter}");
    expect(createQuickTask).not.toHaveBeenCalled();

    await userEvent.click(within(notice).getByRole("button", { name: "Keep in title" }));
    expect(within(region()).queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Add it" })).toBeEnabled();
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ title: "3點 開會", when_date: null });
  });

  it("rewriting it clears the notice", async () => {
    const box = await openSheet();
    await userEvent.type(box, "3點 開會");
    expect(within(region()).getByRole("alert")).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "下午3點 開會");
    expect(within(region()).queryByRole("alert")).toBeNull();
    expect(chipsOf()).toContain("Today 15:00");
  });
});

describe("# lists tags", () => {
  it("opens on #, filters as you type, and ↓ Enter chooses (a hidden tag is not offered)", async () => {
    const box = await openSheet();
    await userEvent.type(box, "read #sc");
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["#schedule", "#school"]);
    expect(within(list).queryByText("#hid")).toBeNull();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect((box as HTMLInputElement).value).toBe("read #school ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(createQuickTask).not.toHaveBeenCalled();
    expect(chipsOf()).toContain("#school");
  });

  it("a click on an option chooses it; Esc closes the list without leaving the sheet", async () => {
    const box = await openSheet();
    await userEvent.type(box, "#w");
    await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "#work" }));
    expect((box as HTMLInputElement).value).toBe("#work ");
    await userEvent.type(box, "#");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Add a task" })).toBeInTheDocument();
  });

  it("Enter with no list still adds the task", async () => {
    const box = await openSheet();
    await userEvent.type(box, "buy milk{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
  });
});

describe("@ lists notes", () => {
  it("lists the latest notes on a bare @, and a chosen note is written into by its id", async () => {
    const box = await openSheet();
    await userEvent.type(box, "ship it @");
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option").length).toBe(3);
    await userEvent.click(within(list).getByRole("option", { name: "My trip" }));
    expect((box as HTMLInputElement).value).toBe("ship it @My_trip ");
    // another note has the same words as its title: the id decides, not the name
    const search = vi.spyOn(reads.notes, "search").mockResolvedValue({ rows: [{ id: "other", title: "My_trip", node_type: "content", snippet: null }], offline: false, fieldFilterSkipped: false });
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect(createQuickTask.mock.calls[0]![0]).toMatchObject({ title: "ship it", note: { id: "c", title: "My trip" } });
    expect(search).not.toHaveBeenCalled();
  });

  it("searches as you type with the one note search", async () => {
    const search = vi.spyOn(reads.notes, "search").mockResolvedValue({ rows: [{ id: "bb", title: "Reading list", node_type: "content", snippet: null }], offline: false, fieldFilterSkipped: false });
    const box = await openSheet();
    await userEvent.type(box, "@read");
    expect(await screen.findByRole("option", { name: "Reading list" })).toBeInTheDocument();
    expect(search).toHaveBeenLastCalledWith("read");
  });

  it("editing a chosen note's word undoes the choice: it is looked up by the typed name again", async () => {
    const box = await openSheet();
    await userEvent.type(box, "x @");
    await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "Roadmap" }));
    await userEvent.type(box, "{Backspace}{Backspace}");
    const search = vi.spyOn(reads.notes, "search").mockResolvedValue({ rows: [], offline: false, fieldFilterSkipped: false });
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(createQuickTask).not.toHaveBeenCalled();
  });
});

describe("typing with an input method (IME)", () => {
  it("no list opens, and Enter does not choose or add, while composing", async () => {
    const box = await openSheet();
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "#sc", selectionStart: 3 } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(createQuickTask).not.toHaveBeenCalled();
    expect((box as HTMLInputElement).value).toBe("#sc");
    fireEvent.compositionEnd(box);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("with the list open, an Enter that ends a composition does not choose either", async () => {
    const box = await openSheet();
    await userEvent.type(box, "#sc");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect((box as HTMLInputElement).value).toBe("#sc");
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceHistory } from "../components/history";
import * as historyApi from "../lib/history/workspaceHistoryApi";
import type { DayNote } from "@onden/contract";
import { setLocalePref } from "../lib/i18n";
import { noWorkspaceData } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { nodeMutations } from "../lib/data";
import { activityFixture, feedDayFixture, feedFixture } from "./workspaceHistoryFixtures";
import { addDays, todayId } from "../lib/localDate";
import type { DeletedNote } from "@onden/contract";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

vi.mock("../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(), fetchFeed: vi.fn(), fetchDayNotes: vi.fn(), fetchDeleted: vi.fn(), fetchDeletedBody: vi.fn(),
}));
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  nodeMutations: { undeleteNode: vi.fn() },
}));
// The slider itself is NoteHistory's own tests; here only which note and day the column is given.
vi.mock("../components/history/WorkspaceHistoryNotePane", () => ({
  default: (p: { noteId: string; day: string; onChanged: () => void }) => (
    <div data-testid="note-pane">{p.noteId}@{p.day}<button onClick={p.onChanged}>changed</button></div>
  ),
}));

const api = vi.mocked(historyApi);
const today = todayId();
const yesterday = addDays(today, -1);
let width = 1200;

beforeAll(async () => { await import("../components/OverviewPreview"); });
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  width = 1200;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: width, height: 0 }) as DOMRect);
  setLocalePref("zh-TW");
  resetAppState({ data: noWorkspaceData });
  api.fetchActivity.mockResolvedValue(activityFixture());
  api.fetchFeed.mockResolvedValue(feedFixture());
  api.fetchDeleted.mockResolvedValue({ notes: [], older_cursor: null });
});
afterEach(() => { cleanup(); setLocalePref("system"); localStorage.clear(); vi.restoreAllMocks(); });

const onOpenNote = vi.fn();
const onOpenNoteHistory = vi.fn();
const renderScreen = () => render(<WorkspaceHistory online onOpenNote={onOpenNote} onOpenNoteHistory={onOpenNoteHistory} onOpenInbox={vi.fn()} />);
// The note rows, not the AI run card's list (which can name the same note).
const rowOf = async (name: RegExp) => {
  await screen.findAllByRole("button", { name });
  return screen.getAllByRole("button", { name }).find((b) => !b.closest("article"))!;
};

describe("WorkspaceHistory: two columns", () => {
  it("is two columns from 1100px of the page's own width, one below", async () => {
    width = 1099;
    const { unmount } = renderScreen();
    await rowOf(/演算法/);
    expect(screen.queryByTestId("note-pane")).toBeNull();
    expect(document.querySelector(".wh-split")).toBeNull();
    unmount();
    width = 1100;
    renderScreen();
    expect(await screen.findByTestId("note-pane")).toBeInTheDocument();
    expect(document.querySelector(".wh-split")).not.toBeNull();
  });

  it("opens the first (newest) row by default, on the day it belongs to", async () => {
    renderScreen();
    expect(await screen.findByTestId("note-pane")).toHaveTextContent(`n1@${today}`);
    expect(await rowOf(/演算法/)).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /新筆記/ })).not.toHaveAttribute("aria-current");
    expect(onOpenNoteHistory).not.toHaveBeenCalled();
  });

  it("picking another row changes the column", async () => {
    renderScreen();
    await screen.findByTestId("note-pane");
    fireEvent.click(await rowOf(/新筆記/));
    expect(screen.getByTestId("note-pane")).toHaveTextContent(`n4@${today}`);
    expect(await rowOf(/新筆記/)).toHaveAttribute("aria-current", "true");
    expect(await rowOf(/演算法/)).not.toHaveAttribute("aria-current");
    expect(onOpenNoteHistory).not.toHaveBeenCalled();   // no dialog
  });

  it("picking another day shows only that day's rows and opens its first row on that day", async () => {
    const day2 = feedDayFixture(yesterday, { agent_runs: [], notes: [{ ...feedDayFixture().notes[0]!, edits: 1 }, { ...feedDayFixture().notes[1]!, id: "n7", title: "第二篇" }] });
    api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today), day2], earlier_day: null });
    renderScreen();
    await screen.findByTestId("note-pane");
    fireEvent.click(await rowOf(/新筆記/));                      // a non-first row chosen on today
    expect(screen.getByTestId("note-pane")).toHaveTextContent(`n4@${today}`);
    fireEvent.click(screen.getAllByRole("button", { name: /^\d+\/\d+，\d+ 次修改$/ })[12]!);   // yesterday's bar
    await waitFor(() => expect(screen.getByTestId("note-pane")).toHaveTextContent(`n1@${yesterday}`));
    expect(screen.queryByRole("button", { name: /新筆記/ })).toBeNull();
    const rows = document.querySelectorAll(".wh-note-link");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[1]).not.toHaveAttribute("aria-current");
    expect(onOpenNoteHistory).not.toHaveBeenCalled();
  });

  it("up and down move the pick along the day's rows and stop at its ends, Enter opens the note", async () => {
    renderScreen();
    await screen.findByTestId("note-pane");
    const first = await rowOf(/演算法/);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("button", { name: /新筆記/ });
    expect(second).toHaveFocus();
    expect(screen.getByTestId("note-pane")).toHaveTextContent("n4@");
    fireEvent.keyDown(second, { key: "ArrowDown" });   // yesterday's rows are not in the list
    expect(screen.getByTestId("note-pane")).toHaveTextContent(`n4@${today}`);
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(screen.getByTestId("note-pane")).toHaveTextContent("n1@");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByTestId("note-pane")).toHaveTextContent(`n1@${today}`);
    fireEvent.keyDown(screen.getByRole("button", { name: /新筆記/ }), { key: "Enter" });
    expect(onOpenNote).toHaveBeenCalledExactlyOnceWith("n4");
  });

  it("asks for a quiet hint when there is nothing to pick", async () => {
    api.fetchFeed.mockResolvedValue({ days: [], earlier_day: null });
    renderScreen();
    expect(await screen.findByText("選一筆改動，在這裡看改了什麼")).toBeInTheDocument();
    expect(screen.queryByTestId("note-pane")).toBeNull();
  });

  it("reads the list again after the column changed something, keeping the open note", async () => {
    renderScreen();
    await screen.findByTestId("note-pane");
    fireEvent.click(await rowOf(/新筆記/));
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "changed" }));
    await waitFor(() => expect(api.fetchFeed).toHaveBeenCalledTimes(2));
    await rowOf(/新筆記/);
    expect(screen.getByTestId("note-pane")).toHaveTextContent("n4@");
  });

  it("the two columns scroll on their own", async () => {
    renderScreen();
    await screen.findByTestId("note-pane");
    expect(document.querySelector(".wh-list-pane")).not.toBeNull();
    expect(document.querySelector(".wh-detail-pane")).not.toBeNull();
  });

  it("narrow: a row still opens the note's history on its day in a dialog", async () => {
    width = 800;
    renderScreen();
    fireEvent.click(await rowOf(/演算法/));
    expect(onOpenNoteHistory).toHaveBeenCalledExactlyOnceWith("n1", today);
    expect(screen.queryByTestId("note-pane")).toBeNull();
  });
});

describe("WorkspaceHistory: a busy day shows a page of notes and the rest on request", () => {
  const note = (i: number): DayNote => ({
    id: `m${i}`, title: `大量筆記 ${i}`, space_id: null, edits: 1, first_at: `${today}T01:00:00Z`, last_at: `${today}T01:00:00Z`,
    actors: [{ name: "你", kind: "human" }], created: false, change: null, ink: null, board_ink: null,
  });
  const busy = () => feedDayFixture(today, { agent_runs: [], notes: [note(1), note(2)], notes_total: 5, edits_total: 5 });
  beforeEach(() => { api.fetchFeed.mockResolvedValue({ days: [busy()], earlier_day: null }); });

  it("counts the whole day's edits, says how many notes are left, and appends the next page", async () => {
    api.fetchDayNotes.mockResolvedValue({ notes: [note(3), note(4), note(5)], notes_total: 5, edits_total: 5 });
    renderScreen();
    expect(await screen.findByText(/5 次修改/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "顯示更多（還有 3 篇）" }));
    expect(await screen.findByRole("button", { name: /大量筆記 5/ })).toBeInTheDocument();
    expect(api.fetchDayNotes).toHaveBeenCalledExactlyOnceWith(today, 2, 50, null);
    expect(screen.getAllByRole("button", { name: /大量筆記/ })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /顯示更多/ })).toBeNull();
  });

  it("keeps the notes on screen and says so when the next page does not load", async () => {
    api.fetchDayNotes.mockRejectedValue(new Error("offline"));
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "顯示更多（還有 3 篇）" }));
    expect(await screen.findByText("暫時無法載入歷史，請再試一次。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /大量筆記/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "顯示更多（還有 3 篇）" })).toBeEnabled();
  });

  it("shows no 顯示更多 when the day fits on the page", async () => {
    api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today)], earlier_day: null });
    renderScreen();
    await rowOf(/演算法/);
    expect(screen.queryByRole("button", { name: /顯示更多/ })).toBeNull();
  });
});

describe("WorkspaceHistory: two columns, recently deleted", () => {
  const deleted = (over: Partial<DeletedNote> = {}): DeletedNote => ({ id: "d1", title: "舊計畫", deleted_at: `${yesterday}T06:00:00Z`, space_id: null, blank: false, ...over });
  beforeEach(() => { localStorage.setItem("onden.history.tab", JSON.stringify("deleted")); });
  const open = async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("tab", { name: "最近刪除" }));
  };

  it("shows what the first deleted note said (read only), with a button to bring it back", async () => {
    api.fetchDeleted.mockResolvedValue({ notes: [deleted(), deleted({ id: "d2", title: "另一篇" })], older_cursor: null });
    api.fetchDeletedBody.mockResolvedValue({ id: "d1", title: "舊計畫", markdown: "# 計畫\n\n最後一段文字", deleted_at: "x" });
    await open();
    const pane = document.querySelector(".wh-detail-pane") as HTMLElement;
    expect(await within(pane).findByText("最後一段文字")).toBeInTheDocument();
    expect(api.fetchDeletedBody).toHaveBeenCalledWith("d1");
    expect(within(pane).queryByRole("textbox")).toBeNull();
    expect(within(pane).getByRole("heading", { name: "舊計畫" })).toBeInTheDocument();

    vi.mocked(nodeMutations.undeleteNode).mockResolvedValue(true);
    fireEvent.click(within(pane).getByRole("button", { name: "救回" }));
    await waitFor(() => expect(nodeMutations.undeleteNode).toHaveBeenCalledWith("d1"));
  });

  it("picking another deleted note reads that one", async () => {
    api.fetchDeleted.mockResolvedValue({ notes: [deleted(), deleted({ id: "d2", title: "另一篇" })], older_cursor: null });
    api.fetchDeletedBody.mockImplementation(async (id) => ({ id, title: "", markdown: id === "d2" ? "第二篇內容" : "第一篇內容", deleted_at: "x" }));
    await open();
    const pane = document.querySelector(".wh-detail-pane") as HTMLElement;
    await within(pane).findByText("第一篇內容");
    fireEvent.click(screen.getByRole("button", { name: /另一篇/ }));
    expect(await within(pane).findByText("第二篇內容")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: /另一篇/ }), { key: "ArrowUp" });
    expect(await within(pane).findByText("第一篇內容")).toBeInTheDocument();
  });

  it("the blank-notes row says there is nothing to see", async () => {
    api.fetchDeleted.mockResolvedValue({ notes: [deleted({ id: "b1", title: "", blank: true }), deleted({ id: "b2", title: "", blank: true })], older_cursor: null });
    await open();
    const pane = document.querySelector(".wh-detail-pane") as HTMLElement;
    expect(await within(pane).findByText("2 篇空白筆記，沒有內容可看")).toBeInTheDocument();
    expect(api.fetchDeletedBody).not.toHaveBeenCalled();
  });

  it("an empty list leaves a quiet hint, and a failed read can be tried again", async () => {
    await open();
    expect(await screen.findByText("選一篇刪除的筆記，在這裡看它寫了什麼")).toBeInTheDocument();
    cleanup();
    api.fetchDeleted.mockResolvedValue({ notes: [deleted()], older_cursor: null });
    api.fetchDeletedBody.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ id: "d1", title: "", markdown: "回來了", deleted_at: "x" });
    await open();
    const pane = document.querySelector(".wh-detail-pane") as HTMLElement;
    fireEvent.click(await within(pane).findByRole("button", { name: "重試" }));
    expect(await within(pane).findByText("回來了")).toBeInTheDocument();
  });

  it("narrow: no detail column and no extra buttons on the rows", async () => {
    width = 800;
    api.fetchDeleted.mockResolvedValue({ notes: [deleted()], older_cursor: null });
    await open();
    await screen.findByText("舊計畫");
    expect(document.querySelector(".wh-detail-pane")).toBeNull();
    expect(api.fetchDeletedBody).not.toHaveBeenCalled();
    expect(document.querySelector(".wh-deleted-pick")).toBeNull();
  });
});

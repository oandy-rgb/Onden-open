// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInk, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import { NoteHistory, WorkspaceHistory } from "../components/history";
import type { ContentNode } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
import { todayId } from "../lib/localDate";
import * as historyApi from "../lib/history/workspaceHistoryApi";
import { activityFixture, feedDayFixture } from "./workspaceHistoryFixtures";
import type { DayNote } from "@onden/contract";

vi.mock("../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(), fetchFeed: vi.fn(), fetchDeleted: vi.fn(),
}));
const h = vi.hoisted(() => ({ inkChange: vi.fn(), inkEdits: vi.fn(), versions: vi.fn(), restoreInk: vi.fn() }));
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  reads: { notes: { inkChange: h.inkChange, inkEdits: h.inkEdits, versions: h.versions } },
  nodeMutations: { ...(await original<typeof import("../lib/data")>()).nodeMutations, restoreInkVersion: h.restoreInk },
}));
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => ({ user: { id: "u1", name: "你" } }) }));

const api = vi.mocked(historyApi);
const stroke = (id: string): InkStroke => ({ id, points: [[0, 0], [10, 10], [20, 5]], color: "#112233", size: 2, toolId: "pen" });
const drawing = (ids: string[]): string => encodeInk({ version: 1, strokes: ids.map(stroke), erased: {}, page: { width: 1000 } } satisfies InkDocument);

const YOU = [{ name: "你", kind: "human" as const }];
const inkNote: DayNote = {
  id: "ink1", title: "手寫講義", space_id: null, edits: 1, first_at: "2026-10-24T06:10:00Z", last_at: "2026-10-24T06:20:00Z", actors: YOU, created: false,
  change: null, ink: { added: 12, erased: 3, before_event: "10", after_event: "14" }, board_ink: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setLocalePref("zh-TW");
  api.fetchActivity.mockResolvedValue(activityFixture());
  api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(todayId(), { notes: [inkNote], agent_runs: [] })], earlier_day: null });
  api.fetchDeleted.mockResolvedValue({ notes: [], older_cursor: null });
  h.inkChange.mockResolvedValue({ before: drawing(["a", "b"]), after: drawing(["a", "c", "d"]) });
});
afterEach(() => { cleanup(); setLocalePref("system"); localStorage.clear(); });

describe("History: handwriting changes", () => {
  it("tells what a handwriting note's day drew and erased, without reading any drawing", async () => {
    render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
    const row = (await screen.findByRole("button", { name: /手寫講義/ })).closest("li")!;
    expect(within(row).getByText("手寫：加了 12 筆、擦掉 3 筆")).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/\b14\b|\b10\b/); // the saves' ids are never shown
    expect(h.inkChange).not.toHaveBeenCalled();
  });

  it("reads the two drawings once, when the picture is opened, and draws the change", async () => {
    render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
    const toggle = await screen.findByRole("button", { name: "看改了哪裡" });
    expect(h.inkChange).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    const picture = await screen.findByRole("img", { name: "手寫改了哪裡" });
    expect(picture.querySelector("svg")).not.toBeNull();
    expect(h.inkChange).toHaveBeenCalledTimes(1);
    expect(h.inkChange).toHaveBeenCalledWith("ink1", "handwriting", expect.objectContaining({ before_event: "10", after_event: "14" }));
    // closing and opening again does not read twice more than once per opening
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByRole("img", { name: "手寫改了哪裡" })).toBeNull();
  });

  it("says so, and offers to try again, when the drawings cannot be read", async () => {
    h.inkChange.mockRejectedValueOnce(new Error("offline"));
    render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "看改了哪裡" }));
    expect(await screen.findByText(/無法載入這張手寫圖/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重試" }));
    expect(await screen.findByRole("img", { name: "手寫改了哪裡" })).toBeInTheDocument();
  });

  it("puts the text change and the drawing change on one line when a note had both", async () => {
    api.fetchFeed.mockResolvedValue({
      days: [feedDayFixture(todayId(), { agent_runs: [], notes: [{ ...inkNote, change: { added: 1, changed: 0, removed: 0, sections: [], sample: null, sample_kind: null } }] })],
      earlier_day: null,
    });
    render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
    expect(await screen.findByText("新增 1 段 · 手寫：加了 12 筆、擦掉 3 筆")).toBeInTheDocument();
  });

  it("lists a note's handwriting edits in its history, and reads a picture only when one is opened", async () => {
    const node: ContentNode = { id: "ink1", title: "手寫講義", slug: "x", markdown: "", source_type: "manual", node_type: "content", parent_id: null };
    h.versions.mockResolvedValue([]);
    h.inkEdits.mockImplementation(async (_id: string, kind: string) => kind === "board" ? [] : [
      { id: "14", added: 0, erased: 5, before_event: "10", after_event: "14", changed_at: "2026-10-24T06:20:00Z", actor_name: "你", actor_kind: "human", saves: 4 },
      { id: "10", added: 7, erased: 0, before_event: null, after_event: "10", changed_at: "2026-10-23T06:20:00Z", actor_name: "Claude", actor_kind: "agent", saves: 1 },
    ]);
    render(<NoteHistory node={node} currentMarkdown="" nodes={[node]} online inline onOpenNote={vi.fn()} />);
    const list = await screen.findByRole("region", { name: "手寫改動" });
    expect(within(list).getByText("手寫：擦掉 5 筆")).toBeInTheDocument();
    expect(within(list).getByText("手寫：加了 7 筆")).toBeInTheDocument();
    expect(h.inkChange).not.toHaveBeenCalled();
    fireEvent.click(within(list).getAllByRole("button", { name: "看改了哪裡" })[1]!);
    await waitFor(() => expect(h.inkChange).toHaveBeenCalledTimes(1));
    expect(h.inkChange).toHaveBeenCalledWith("ink1", "handwriting", expect.objectContaining({ before_event: null, after_event: "10" }));
  });

  it("tells a whiteboard's pen layer from the handwriting page in the day's list and in the note's history", async () => {
    api.fetchFeed.mockResolvedValue({
      days: [feedDayFixture(todayId(), { agent_runs: [], notes: [{ ...inkNote, ink: null, board_ink: { added: 4, erased: 1, before_event: null, after_event: "21" } }] })],
      earlier_day: null,
    });
    render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
    expect(await screen.findByText("白板筆跡：加了 4 筆、擦掉 1 筆")).toBeInTheDocument();
    expect(screen.queryByText(/手寫：/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "看改了哪裡" }));
    await waitFor(() => expect(h.inkChange).toHaveBeenCalledWith("ink1", "board", expect.objectContaining({ after_event: "21" })));
  });

  it("puts a whiteboard drawing back from the note's history, naming its own drawing, and can undo it", async () => {
    const node: ContentNode = { id: "ink1", title: "白板", slug: "x", markdown: "", source_type: "manual", node_type: "content", parent_id: null };
    const onChanged = vi.fn();
    h.versions.mockResolvedValue([]);
    h.restoreInk.mockResolvedValue(true);
    h.inkEdits.mockImplementation(async (_id: string, kind: string) => kind === "handwriting" ? [] : [
      { id: "22", added: 2, erased: 0, before_event: "21", after_event: "22", changed_at: "2026-10-24T06:20:00Z", actor_name: "你", actor_kind: "human", saves: 1 },
      { id: "21", added: 3, erased: 0, before_event: null, after_event: "21", changed_at: "2026-10-23T06:20:00Z", actor_name: "你", actor_kind: "human", saves: 1 },
    ]);
    render(<NoteHistory node={node} currentMarkdown="" nodes={[node]} online inline onOpenNote={vi.fn()} onChanged={onChanged} />);
    const list = await screen.findByRole("region", { name: "白板筆跡改動" });
    expect(screen.queryByRole("region", { name: "手寫改動" })).toBeNull();
    expect(within(list).getByText("白板筆跡：加了 3 筆")).toBeInTheDocument();
    // The newest row is the drawing now: only the older one offers to go back.
    const back = within(list).getAllByRole("button", { name: "回到這張" });
    expect(back).toHaveLength(1);
    fireEvent.click(back[0]!);
    await waitFor(() => expect(h.restoreInk).toHaveBeenCalledWith("ink1", "board", "21"));
    expect(await screen.findByRole("status")).toHaveTextContent("已回到");
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "復原" }));
    await waitFor(() => expect(h.restoreInk).toHaveBeenLastCalledWith("ink1", "board", "22"));
  });
});

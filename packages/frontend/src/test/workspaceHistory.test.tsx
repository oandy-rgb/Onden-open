// @vitest-environment jsdom
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceHistory } from "../components/history";
import * as historyApi from "../lib/history/workspaceHistoryApi";
import { ApiError } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
import { nodeMutations } from "../lib/data";
import { activityFixture, DELETED, feedDayFixture, feedFixture, RUN } from "./workspaceHistoryFixtures";
import { addDays, setWorkspaceTimeZoneSource, todayId } from "../lib/localDate";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

vi.mock("../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(), fetchFeed: vi.fn(), fetchDeleted: vi.fn(),
}));
const writer = vi.hoisted(() => ({ undoAgentRun: vi.fn(), redoAgentRun: vi.fn(), rewindWorkspace: vi.fn(), undoRewind: vi.fn() }));
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  nodeMutations: { undeleteNode: vi.fn() },
  historyWriter: writer,
}));

afterEach(() => { setLocalePref("system"); localStorage.clear(); vi.restoreAllMocks(); });

const api = vi.mocked(historyApi);
const onOpenNoteHistory = vi.fn();
const onOpenInbox = vi.fn();
const today = todayId();
const yesterday = addDays(today, -1);

function renderScreen() {
  return render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={onOpenNoteHistory} onOpenInbox={onOpenInbox} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setLocalePref("zh-TW");
  api.fetchActivity.mockResolvedValue(activityFixture());
  api.fetchFeed.mockResolvedValue(feedFixture());
  api.fetchDeleted.mockResolvedValue({ notes: DELETED, older_cursor: null });
});

async function openSheet() {
  renderScreen();
  fireEvent.click(await screen.findByRole("button", { name: "復原這次修改" }));
  return await screen.findByRole("dialog");
}

describe("WorkspaceHistory: the list of changes", () => {
  it("shows only the newest day with changes, under a heading with its count", async () => {
    renderScreen();
    expect(await screen.findByRole("heading", { name: /^今天 \d+\/\d+ · 6 次修改$/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^昨天/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /讀書計畫/ })).toBeNull();
    const groups = document.querySelectorAll("[data-day]");
    expect([...groups].map((g) => g.getAttribute("data-day"))).toEqual([today]);
    expect(api.fetchFeed).toHaveBeenCalledWith(today, 14, null);
  });

  it("writes what changed on each row: summary with the section, then the first changed paragraph", async () => {
    renderScreen();
    const row = (await screen.findAllByRole("button", { name: /演算法/ })).find((b) => !b.closest("article"))!.closest("li")!;
    expect(within(row).getByText("改了 2 段、刪了 1 段，在「待辦」")).toBeInTheDocument();
    expect(within(row).getByText("複習動態規劃的狀態轉移")).toHaveClass("wh-note-sample");
    expect(within(row).getByText("複習動態規劃的狀態轉移")).not.toHaveClass("removed");
    const added = screen.getByRole("button", { name: /新筆記/ }).closest("li")!;
    expect(within(added).getByText("新增 3 段")).toBeInTheDocument();
    // only you → no name; someone else → their name; a removed sample is struck through
    expect(within(row).queryByText(/你/)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^\d+\/\d+，\d+ 次修改$/ })[12]!);
    const other = (await screen.findByRole("button", { name: /讀書計畫/ })).closest("li")!;
    expect(within(other).getByText("刪了 1 段 · Claude")).toBeInTheDocument();
    expect(within(other).getByText("舊的第三章進度")).toHaveClass("removed");
  });

  it("says so when only the title (not the text) changed", async () => {
    const day = feedDayFixture(today, { agent_runs: [] });
    day.notes[0]!.change = { added: 0, changed: 0, removed: 0, sections: [], sample: null, sample_kind: null };
    api.fetchFeed.mockResolvedValue({ days: [day], earlier_day: null });
    renderScreen();
    const row = (await screen.findAllByRole("button", { name: /演算法/ })).find((b) => !b.closest("article"))!.closest("li")!;
    expect(within(row).getByText("內文沒有改動")).toBeInTheDocument();
    expect(row.querySelector(".wh-note-sample")).toBeNull();
  });

  it("calls a note made that day with nothing in it yet new, not unchanged", async () => {
    const day = feedDayFixture(today, { agent_runs: [] });
    day.notes[0]!.created = true;
    day.notes[0]!.change = { added: 0, changed: 0, removed: 0, sections: [], sample: null, sample_kind: null };
    api.fetchFeed.mockResolvedValue({ days: [day], earlier_day: null });
    renderScreen();
    const row = (await screen.findAllByRole("button", { name: /演算法/ })).find((b) => !b.closest("article"))!.closest("li")!;
    expect(within(row).queryByText("內文沒有改動")).toBeNull();
    expect(within(row).getByText(/新增/)).toBeInTheDocument();
  });

  it("opens that note's history on the day of the group the row is in", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /新筆記/ }));
    expect(onOpenNoteHistory).toHaveBeenLastCalledWith("n4", today);
    fireEvent.click(screen.getAllByRole("button", { name: /^\d+\/\d+，\d+ 次修改$/ })[12]!);
    fireEvent.click(await screen.findByRole("button", { name: /讀書計畫/ }));
    expect(onOpenNoteHistory).toHaveBeenLastCalledWith("n9", yesterday);
  });

  it("uses the agent's name in the legend when there is one agent", async () => {
    renderScreen();
    await screen.findByText("整理了讀書筆記");
    expect(within(document.querySelector(".wh-legend")!).getByText("Claude")).toBeInTheDocument();
  });

  it("says there is nothing yet when history is empty", async () => {
    api.fetchFeed.mockResolvedValue({ days: [], earlier_day: null });
    renderScreen();
    expect(await screen.findByText("還沒有任何修改。")).toBeInTheDocument();
  });
});

describe("WorkspaceHistory: the chart picks the day", () => {
  const barName = /^\d+\/\d+，\d+ 次修改$/;
  const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const quietWindow = (until: string, each = 1) => Array.from({ length: 14 }, (_, i) => ({ date: addDays(until, i - 13), you: each, agents: 0 }));

  it("draws 14 day buttons; every day can be pressed; the newest day with edits starts selected", async () => {
    renderScreen();
    const bars = await screen.findAllByRole("button", { name: barName });
    expect(bars).toHaveLength(14);
    bars.forEach((b) => expect(b).toBeEnabled());
    expect(bars[13]).toHaveAttribute("aria-pressed", "true");
    expect(bars.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    expect(bars[13]).toHaveAccessibleName(/，18 次修改/);
  });

  it("sizes bars by the square root, at least 4px, and a quiet day is only a baseline", async () => {
    renderScreen();
    const bars = await screen.findAllByRole("button", { name: barName });
    const height = (el: HTMLElement) => (el.querySelector(".wh-stack") as HTMLElement | null)?.style.getPropertyValue("--wh-h");
    expect(height(bars[13]!)).toBe("100%");                                  // the busiest day
    expect(parseFloat(height(bars[3]!)!)).toBeCloseTo(Math.sqrt(3 / 18) * 100, 1);  // not 3/18 = 17%
    expect(bars[0]!.querySelector(".wh-stack")).toBeNull();
    expect(bars[0]!.querySelector(".wh-baseline")).not.toBeNull();
  });

  it("pressing a day marks it and leaves only that day in the list", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    const bars = screen.getAllByRole("button", { name: barName });
    fireEvent.click(bars[12]!);
    expect(bars[12]).toHaveAttribute("aria-pressed", "true");
    expect(bars[13]).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByRole("heading", { name: /^昨天 \d+\/\d+ · 2 次修改$/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^今天/ })).toBeNull();
    expect([...document.querySelectorAll("[data-day]")].map((g) => g.getAttribute("data-day"))).toEqual([yesterday]);
    expect(screen.getByRole("button", { name: /讀書計畫/ })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /演算法/ }).filter((b) => !b.closest("article"))).toEqual([]);
    fireEvent.click(bars[13]!);
    expect(await screen.findByRole("heading", { name: /^今天/ })).toBeInTheDocument();
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);   // both days were in the first page
  });

  it("a day without edits says so in one quiet line", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    fireEvent.click(screen.getAllByRole("button", { name: barName })[0]!);
    const line = await screen.findByText("這天沒有修改");
    expect(line).toHaveClass("wh-empty");
    expect(document.querySelector("[data-day]")).toBeNull();
    expect(screen.queryByText("還沒有任何修改。")).toBeNull();
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);   // the first page already reaches it
  });

  it("no longer has the infinite scroll, the 更早 button or the end line", async () => {
    api.fetchFeed.mockResolvedValue({ ...feedFixture(), earlier_day: addDays(today, -20) });
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    expect(screen.queryByRole("button", { name: "更早" })).toBeNull();
    expect(screen.queryByText("沒有更早的修改")).toBeNull();
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);
  });

  it("moves 14 days back and forth; never past today", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    const later = screen.getByRole("button", { name: "往後看 14 天" });
    expect(later).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "往前看 14 天" }));
    await waitFor(() => expect(api.fetchActivity).toHaveBeenLastCalledWith(14, addDays(today, -14), null));
    expect(later).toBeEnabled();
    fireEvent.click(later);
    await waitFor(() => expect(api.fetchActivity).toHaveBeenLastCalledWith(14, undefined, null));
    expect(later).toBeDisabled();
  });

  it("a day outside the new 14 days is dropped: the newest day with edits there is selected", async () => {
    const until = addDays(today, -14);
    const window = quietWindow(until, 0).map((d, i) => (i === 5 || i === 9 ? { ...d, you: 2 } : d));
    api.fetchActivity.mockImplementation(async (_n, u) => (u ? window : activityFixture()));
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    fireEvent.click(screen.getByRole("button", { name: "往前看 14 天" }));
    await waitFor(() => expect(api.fetchActivity).toHaveBeenLastCalledWith(14, until, null));
    const bars = await screen.findAllByRole("button", { name: new RegExp(`^${md(window[9]!.date)}，2 次修改$`) });
    await waitFor(() => expect(bars[0]).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
  });

  it("with no edits in the new 14 days the last day is selected and says so", async () => {
    const until = addDays(today, -14);
    api.fetchActivity.mockImplementation(async (_n, u) => (u ? quietWindow(u, 0) : activityFixture()));
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    fireEvent.click(screen.getByRole("button", { name: "往前看 14 天" }));
    await waitFor(() => expect(api.fetchActivity).toHaveBeenLastCalledWith(14, until, null));
    const last = await screen.findByRole("button", { name: `${md(until)}，0 次修改` });
    await waitFor(() => expect(last).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByText("這天沒有修改")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^今天/ })).toBeNull();
  });

  it("going away and back to the first 14 days finds the day picked there still selected", async () => {
    api.fetchActivity.mockImplementation(async (_n, u) => (u ? quietWindow(u) : activityFixture()));
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    fireEvent.click(screen.getAllByRole("button", { name: barName })[12]!);   // yesterday
    await screen.findByRole("heading", { name: /^昨天/ });
    fireEvent.click(screen.getByRole("button", { name: "往前看 14 天" }));
    await waitFor(() => expect(api.fetchActivity).toHaveBeenLastCalledWith(14, addDays(today, -14), null));
    fireEvent.click(await screen.findByRole("button", { name: "往後看 14 天" }));
    await waitFor(() => expect(api.fetchActivity).toHaveBeenLastCalledWith(14, undefined, null));
    expect(await screen.findByRole("heading", { name: /^昨天/ })).toBeInTheDocument();
  });

  describe("a day in an older page", () => {
    const target = addDays(today, -35);
    const olderWindows = () => api.fetchActivity.mockImplementation(async (_days, until) => until
      ? Array.from({ length: 14 }, (_, i) => ({ date: addDays(until, i - 13), you: 1, agents: 0 }))
      : activityFixture());
    const goBack = async () => {
      renderScreen();
      await screen.findByRole("heading", { name: /^今天/ });
      fireEvent.click(screen.getByRole("button", { name: "往前看 14 天" }));
      await waitFor(() => expect(api.fetchActivity).toHaveBeenLastCalledWith(14, addDays(today, -14), null));
      fireEvent.click(screen.getByRole("button", { name: "往前看 14 天" }));
      return await screen.findByRole("button", { name: `${md(target)}，1 次修改` });
    };

    const page = (date: string, earlier: string | null) => ({ days: [feedDayFixture(date, { agent_runs: [] })], earlier_day: earlier });

    it("loads older pages through that day (showing 載入中…), then shows only that day", async () => {
      olderWindows();
      let release!: () => void;
      api.fetchFeed.mockResolvedValueOnce({ ...feedFixture(), earlier_day: addDays(today, -16) });
      api.fetchFeed.mockResolvedValueOnce(page(addDays(today, -16), target));   // read when the arrow lands on a day it does not reach
      api.fetchFeed.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(page(target, null)); }));
      const bar = await goBack();
      expect(api.fetchFeed).toHaveBeenCalledTimes(2);
      fireEvent.click(bar);
      expect(await screen.findByText("載入中…")).toBeInTheDocument();
      expect(screen.queryByText("這天沒有修改")).toBeNull();
      await waitFor(() => expect(api.fetchFeed).toHaveBeenCalledTimes(3));
      expect(api.fetchFeed).toHaveBeenLastCalledWith(target, 14, null);
      release();
      expect(await screen.findByRole("heading", { name: new RegExp(`^${md(target)} · 6 次修改$`) })).toBeInTheDocument();
      expect([...document.querySelectorAll("[data-day]")].map((g) => g.getAttribute("data-day"))).toEqual([target]);
      expect(screen.queryByText("載入中…")).toBeNull();
    });

    it("says 這天沒有修改 when the pages through that day do not hold it", async () => {
      api.fetchFeed.mockResolvedValueOnce({ ...feedFixture(), earlier_day: addDays(today, -16) });
      api.fetchFeed.mockResolvedValueOnce(page(addDays(today, -16), addDays(today, -60)));
      api.fetchFeed.mockResolvedValueOnce(page(addDays(today, -50), null));   // the pages through that day end without it
      olderWindows();
      const bar = await goBack();
      fireEvent.click(bar);
      expect(await screen.findByText("這天沒有修改")).toBeInTheDocument();
      expect(api.fetchFeed).toHaveBeenCalledTimes(3);
    });

    it("offers a retry when an older page fails, and loads again on it", async () => {
      api.fetchFeed.mockResolvedValueOnce({ ...feedFixture(), earlier_day: addDays(today, -16) });
      api.fetchFeed.mockResolvedValueOnce(page(addDays(today, -16), target));
      api.fetchFeed.mockRejectedValueOnce(new ApiError(500, "x"));
      api.fetchFeed.mockResolvedValueOnce(page(target, null));
      olderWindows();
      const bar = await goBack();
      fireEvent.click(bar);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("暫時無法載入歷史");
      fireEvent.click(within(alert).getByRole("button", { name: "重試" }));
      expect(await screen.findByRole("heading", { name: new RegExp(`^${md(target)} · 6 次修改$`) })).toBeInTheDocument();
    });
  });
});

describe("WorkspaceHistory: the AI run card", () => {
  it("shows the run card and lists what changed per note; a title opens that note's history", async () => {
    renderScreen();
    expect(await screen.findByText("整理了讀書筆記")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "看改了什麼" })).not.toBeInTheDocument();
    expect(screen.getByText("改了 2 段 · 新增 1 段")).toBeInTheDocument();
    expect(within(screen.getByRole("article")).getByText("新增 3 段")).toBeInTheDocument();
    const card = screen.getByRole("article");
    fireEvent.click(within(card).getByRole("button", { name: /演算法/ }));
    expect(onOpenNoteHistory).toHaveBeenCalledWith("n1", today);
  });

  it("drops the 'changed N notes' sentence when the run has no summary: the list says it", async () => {
    api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today, { agent_runs: [{ ...RUN, summary: "" }] })], earlier_day: null });
    renderScreen();
    const card = await screen.findByRole("article");
    expect(within(card).getAllByRole("button", { name: /演算法|新增|改了/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/改了 3 篇筆記/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/一次執行/)).not.toBeInTheDocument();
  });

  it("lists the first 3 notes and folds the rest behind 還有 N 篇 / 收起", async () => {
    const notes = [1, 2, 3, 4, 5].map((i) => ({ id: `m${i}`, title: `筆記${i}`, space_id: null, changed: 1, added: 0, removed: 0 }));
    api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today, { agent_runs: [{ ...RUN, notes }] })], earlier_day: null });
    renderScreen();
    const card = await screen.findByRole("article");
    expect(within(card).getByText("筆記3")).toBeInTheDocument();
    expect(within(card).queryByText("筆記4")).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "還有 2 篇" }));
    expect(within(card).getByText("筆記5")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "收起" }));
    expect(within(card).queryByText("筆記4")).not.toBeInTheDocument();
  });

  it("opens the undo sheet with every note checked and disables undo at zero", async () => {
    const sheet = await openSheet();
    expect(within(sheet).getByText(/復原 Claude 這次的修改/, { selector: "h3" })).toBeInTheDocument();
    const boxes = within(sheet).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    boxes.forEach((b) => expect(b).toBeChecked());
    expect(within(sheet).getByRole("button", { name: "復原 3 篇的修改" })).toBeEnabled();
    boxes.forEach((b) => fireEvent.click(b));
    expect(within(sheet).getByRole("button", { name: "復原 0 篇的修改" })).toBeDisabled();
  });

  it("sends only the checked notes; a partial undo leaves the card open with its undo button (M4)", async () => {
    writer.undoAgentRun.mockResolvedValue({ undone: ["n1"], conflicts: [], skipped: [] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getAllByRole("checkbox")[1]!);
    fireEvent.click(within(sheet).getAllByRole("checkbox")[2]!);
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 1 篇的修改" }));
    await waitFor(() => expect(writer.undoAgentRun).toHaveBeenCalledWith("run-1", ["n1"]));
    expect(await screen.findByText("已復原 Claude 對 1 篇筆記的修改")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "復原這次修改" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取回 Claude 的修改" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an undo of every note turns the card into the undone state", async () => {
    writer.undoAgentRun.mockResolvedValue({ undone: ["n1", "n2", "n3"], conflicts: [], skipped: [] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 3 篇的修改" }));
    expect(await screen.findByText(/已復原 · 3 篇回到 .* 之前的樣子/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取回 Claude 的修改" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "復原這次修改" })).toBeNull();
  });

  it("an undo that skipped everything is not 'undone' (M4)", async () => {
    writer.undoAgentRun.mockResolvedValue({ undone: [], conflicts: [], skipped: ["n1", "n2", "n3"] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 3 篇的修改" }));
    await screen.findByText("3 篇你沒有修改權限，沒有動");
    expect(screen.getByRole("button", { name: "復原這次修改" })).toBeInTheDocument();
  });

  it("a note the run created is listed but not offered, and the rest can still complete the card (M3)", async () => {
    const withNew = { ...feedFixture() };
    withNew.days = withNew.days.map((d) => ({ ...d, agent_runs: d.agent_runs.map((r) => ({ ...r, notes: r.notes.map((n) => (n.id === "n3" ? { ...n, created: true } : n)) })) }));
    api.fetchFeed.mockResolvedValue(withNew);
    writer.undoAgentRun.mockResolvedValue({ undone: ["n1", "n2"], conflicts: [], skipped: [] });
    const sheet = await openSheet();
    expect(within(sheet).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(sheet).getByText("這次新建的筆記，復原不會刪除")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 2 篇的修改" }));
    await waitFor(() => expect(writer.undoAgentRun).toHaveBeenCalledWith("run-1", ["n1", "n2"]));
    expect(await screen.findByRole("button", { name: "取回 Claude 的修改" })).toBeInTheDocument();
  });

  it("reports conflicts (with a way to the inbox) and notes skipped for lack of permission", async () => {
    writer.undoAgentRun.mockResolvedValue({ undone: ["n1"], conflicts: ["n2"], skipped: ["n3", "n4"] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 3 篇的修改" }));
    expect(await screen.findByText(/1 篇有段落兩邊都改過，放在收件匣「等你決定」/)).toBeInTheDocument();
    expect(screen.getByText("2 篇你沒有修改權限，沒有動")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "前往收件匣" }));
    expect(onOpenInbox).toHaveBeenCalled();
  });

  it("keeps the sheet open with a plain message when the undo fails", async () => {
    writer.undoAgentRun.mockRejectedValue(new ApiError(500, "boom"));
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 3 篇的修改" }));
    expect(await within(sheet).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it("brings the agent's changes back (redo) and shows the run as active again", async () => {
    writer.undoAgentRun.mockResolvedValue({ undone: ["n1", "n2", "n3"], conflicts: [], skipped: [] });
    writer.redoAgentRun.mockResolvedValue({ undone: ["n1", "n2", "n3"], conflicts: [] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 3 篇的修改" }));
    fireEvent.click(await screen.findByRole("button", { name: "取回 Claude 的修改" }));
    await waitFor(() => expect(writer.redoAgentRun).toHaveBeenCalledWith("run-1", ["n1", "n2", "n3"]));
    expect(await screen.findByRole("button", { name: "復原這次修改" })).toBeInTheDocument();
  });

  it("shows an already-undone run as undone without a breakdown", async () => {
    api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today, { agent_runs: [{ ...RUN, undone: true }] })], earlier_day: null });
    renderScreen();
    expect(await screen.findByText("已復原")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取回 Claude 的修改" })).toBeInTheDocument();
  });
});

describe("WorkspaceHistory: errors", () => {
  it("shows plain empty states when an older backend answers 404", async () => {
    const notFound = new ApiError(404, "");
    api.fetchActivity.mockRejectedValue(notFound);
    api.fetchFeed.mockRejectedValue(notFound);
    api.fetchDeleted.mockRejectedValue(notFound);
    renderScreen();
    expect(await screen.findByText("還沒有任何修改。")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: /次修改$/ })).toHaveLength(14);
    fireEvent.click(screen.getByRole("tab", { name: "最近刪除" }));
    expect(await screen.findByText("沒有刪掉的筆記。")).toBeInTheDocument();
  });

  it("shows one plain sentence with a retry when loading fails", async () => {
    api.fetchFeed.mockRejectedValueOnce(new ApiError(500, "x")).mockResolvedValue(feedFixture());
    renderScreen();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暫時無法載入歷史");
    fireEvent.click(within(alert).getByRole("button", { name: "重試" }));
    expect(await screen.findByText("整理了讀書筆記")).toBeInTheDocument();
  });
});

describe("WorkspaceHistory: tabs", () => {
  it("has 變更 and 最近刪除 as tabs, 變更 first; the arrow keys and clicks switch", async () => {
    renderScreen();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["變更", "最近刪除"]);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    expect(api.fetchDeleted).not.toHaveBeenCalled();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveFocus();
    expect(await screen.findByText("舊計畫")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[1]!.id);
    fireEvent.keyDown(tabs[1]!, { key: "Home" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tabs[1]!);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  });

  it("remembers the last tab on this device, and works when storage throws", async () => {
    const view = renderScreen();
    fireEvent.click(await screen.findByRole("tab", { name: "最近刪除" }));
    expect(localStorage.getItem("onden.history.tab")).toBe("deleted");
    view.unmount();
    const again = renderScreen();
    expect(await screen.findByRole("tab", { name: "最近刪除" })).toHaveAttribute("aria-selected", "true");
    again.unmount();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    renderScreen();
    const changes = await screen.findByRole("tab", { name: "變更" });
    expect(changes).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "最近刪除" }));
    expect(screen.getByRole("tab", { name: "最近刪除" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("WorkspaceHistory: recently deleted", () => {
  const openDeleted = async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("tab", { name: "最近刪除" }));
  };
  const note = (id: string, title: string, blank = false) => ({ id, title, deleted_at: "2026-10-23T14:05:00Z", blank, space_id: null });

  it("says the workspace's day for a deletion made after local midnight but before UTC midnight (M1)", async () => {
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    try {
      const localToday = todayId();
      const iso = new Date(`${localToday}T00:30:00+08:00`).toISOString(); // the day before in UTC
      api.fetchDeleted.mockResolvedValue({ notes: [{ ...note("m1", "凌晨刪的"), deleted_at: iso }], older_cursor: null });
      await openDeleted();
      expect(await screen.findByText(/^今天 /)).toBeInTheDocument();
      expect(screen.queryByText(/^昨天 /)).toBeNull();
    } finally {
      setWorkspaceTimeZoneSource(() => undefined);
    }
  });

  it("brings back a deleted note and says where it went", async () => {
    vi.mocked(nodeMutations.undeleteNode).mockResolvedValue(true);
    await openDeleted();
    expect(await screen.findByText("舊計畫")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "救回" }));
    await waitFor(() => expect(nodeMutations.undeleteNode).toHaveBeenCalledWith("d1"));
    expect(await screen.findByText("已救回「舊計畫」，放回原本的位置")).toBeInTheDocument();
  });

  it("lists every deleted note, 50 at a time", async () => {
    api.fetchDeleted.mockResolvedValue({ notes: Array.from({ length: 120 }, (_, i) => note(`d${i}`, `舊筆記 ${i}`)), older_cursor: null });
    await openDeleted();
    await screen.findByText("舊筆記 0");
    expect(document.querySelectorAll(".wh-deleted-row")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "顯示更多（還有 70 篇）" }));
    expect(document.querySelectorAll(".wh-deleted-row")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "顯示更多（還有 20 篇）" }));
    expect(document.querySelectorAll(".wh-deleted-row")).toHaveLength(120);
    expect(screen.queryByRole("button", { name: /顯示更多/ })).toBeNull();
  });

  it("「顯示更早」 loads the notes deleted before the first page, by the server's cursor, until there are none (M6)", async () => {
    api.fetchDeleted
      .mockResolvedValueOnce({ notes: [note("d1", "上週刪的")], older_cursor: "c1" })
      .mockResolvedValueOnce({ notes: [note("d2", "兩個月前刪的")], older_cursor: "c2" })
      .mockResolvedValueOnce({ notes: [note("d3", "去年刪的")], older_cursor: null });
    await openDeleted();
    await screen.findByText("上週刪的");
    expect(screen.queryByText("兩個月前刪的")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "顯示更早" }));
    expect(await screen.findByText("兩個月前刪的")).toBeInTheDocument();
    expect(api.fetchDeleted).toHaveBeenLastCalledWith(undefined, null, "c1");
    fireEvent.click(screen.getByRole("button", { name: "顯示更早" }));
    expect(await screen.findByText("去年刪的")).toBeInTheDocument();
    expect(api.fetchDeleted).toHaveBeenLastCalledWith(undefined, null, "c2");
    // Same row, same actions as the first page's, and no control once nothing is left.
    expect(document.querySelectorAll(".wh-deleted-row")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "救回" })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "顯示更早" })).toBeNull();
  });

  it("a failed 「顯示更早」 keeps the list and can be tried again", async () => {
    api.fetchDeleted
      .mockResolvedValueOnce({ notes: [note("d1", "上週刪的")], older_cursor: "c1" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ notes: [note("d2", "兩個月前刪的")], older_cursor: null });
    await openDeleted();
    await screen.findByText("上週刪的");
    fireEvent.click(screen.getByRole("button", { name: "顯示更早" }));
    expect(await screen.findByText("暫時無法載入歷史，請再試一次。")).toBeInTheDocument();
    expect(screen.getByText("上週刪的")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /再試一次|重試/ }));
    expect(await screen.findByText("兩個月前刪的")).toBeInTheDocument();
  });

  it("folds the blank notes into one row on top; the others keep their own rows", async () => {
    api.fetchDeleted.mockResolvedValue({ notes: [note("b1", "", true), note("d2", "舊計畫"), note("b2", "", true), note("b3", "", true)], older_cursor: null });
    await openDeleted();
    const toggle = await screen.findByRole("button", { name: "3 篇空白筆記" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelectorAll(".wh-deleted-row")).toHaveLength(1);
    expect(screen.getByText("舊計畫")).toBeInTheDocument();
    expect(toggle.compareDocumentPosition(screen.getByText("舊計畫")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".wh-deleted-row")).toHaveLength(4);
    expect(screen.getAllByText("未命名")).toHaveLength(3);
  });

  it("brings back all the blank notes one by one and reports how many", async () => {
    api.fetchDeleted.mockResolvedValue({ notes: [note("b1", "", true), note("b2", "", true), note("b3", "", true), note("d2", "舊計畫")], older_cursor: null });
    vi.mocked(nodeMutations.undeleteNode).mockImplementation(async (id: string) => id !== "b2");
    await openDeleted();
    fireEvent.click(await screen.findByRole("button", { name: "全部救回" }));
    expect(await screen.findByText("已救回 2 篇空白筆記，1 篇沒有成功")).toBeInTheDocument();
    expect(vi.mocked(nodeMutations.undeleteNode).mock.calls.map((c) => c[0])).toEqual(["b1", "b2", "b3"]);
  });

  it("offers no 全部永久刪除 when the person may delete none of them for good", async () => {
    api.fetchDeleted.mockResolvedValue({ notes: [note("b1", "", true)], older_cursor: null });
    await openDeleted();
    await screen.findByRole("button", { name: "全部救回" });
    expect(screen.queryByRole("button", { name: "全部永久刪除" })).toBeNull();
  });
});

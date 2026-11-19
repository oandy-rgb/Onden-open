// 「那天的樣子」, 「回到這之前」 and 「還原到這時」 on the History screen: the preview (narrow: a dialog,
// wide: the right column), the dimmed rows and cut line, the confirmation and the rewind card with its undo.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceHistory } from "../components/history";
import * as historyApi from "../lib/history/workspaceHistoryApi";
import * as rewindApi from "../lib/history/rewindApi";
import { ApiError } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
import { noWorkspaceData } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { addDays, todayId } from "../lib/localDate";
import { activityFixture, feedDayFixture } from "./workspaceHistoryFixtures";
import type { WorkspaceAt } from "@onden/contract";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
// The compare view itself is tested in compare/TextCompare.test.tsx (CodeMirror needs a real layout); here it is a stand-in
// that shows both texts, so this file tests what the rewind preview hands it.
vi.mock("../components/compare/TextCompareView", () => ({
  default: ({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) => (
    <div><p>{beforeLabel}</p><pre>{before}</pre><p>{afterLabel}</p><pre>{after}</pre></div>
  ),
}));

vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

vi.mock("../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(), fetchFeed: vi.fn(), fetchDeleted: vi.fn(), fetchDeletedBody: vi.fn(),
}));
vi.mock("../lib/history/rewindApi", async (original) => ({
  ...await original<typeof import("../lib/history/rewindApi")>(),
  fetchWorkspaceAt: vi.fn(), fetchNoteAt: vi.fn(),
}));
const writer = vi.hoisted(() => ({ undoAgentRun: vi.fn(), redoAgentRun: vi.fn(), rewindWorkspace: vi.fn(), undoRewind: vi.fn() }));
vi.mock("../lib/data", async (original) => ({ ...await original<typeof import("../lib/data")>(), historyWriter: writer }));
vi.mock("../components/history/WorkspaceHistoryNotePane", () => ({
  default: (p: { noteId: string }) => <div data-testid="note-pane">{p.noteId}</div>,
}));

const api = vi.mocked(historyApi);
const rw = vi.mocked(rewindApi);
const today = todayId();
const day = addDays(today, -1);
let width = 600;

// The past day's rows, with times on that very day (10:00–14:00 UTC stays one day in any zone).
const at = (hhmm: string) => `${day}T${hhmm}:00.000Z`;
const YOU = [{ name: "你", kind: "human" as const }];
// FeedDay.end_at: the server's end of that day.
const END_OF_DAY = `${day}T15:59:59.999Z`;
const FEED_DAY = {
  date: day,
  end_at: END_OF_DAY,
  system_tidies: [],
  notes_total: 2,
  edits_total: 3,
  notes: [
    { id: "n2", title: "作業系統", space_id: null, edits: 1, first_at: at("13:00"), last_at: at("13:05"), actors: YOU, created: false,
      change: { added: 0, changed: 1, removed: 0, sections: [], sample: "排程", sample_kind: "changed" as const }, ink: null, board_ink: null },
    { id: "n1", title: "演算法", space_id: null, edits: 2, first_at: at("10:00"), last_at: at("10:30"), actors: YOU, created: false,
      change: { added: 1, changed: 0, removed: 0, sections: [], sample: "動態規劃", sample_kind: "added" as const }, ink: null, board_ink: null },
  ],
  agent_runs: [{
    run_id: "run-1", agent_name: "Claude", started_at: at("11:00"), summary: "整理", undone: false,
    notes: [{ id: "n1", title: "演算法", space_id: null, added: 1, changed: 0, removed: 0 }],
  }],
  rewinds: [{
    rewind_id: "rw-1", to: at("09:00"), at: at("12:00"), actor_name: "你", undone: false,
    notes: [
      { id: "n3", title: "舊筆記", space_id: null, kind: "undelete" as const },
      { id: "n4", title: "新筆記", space_id: null, kind: "delete" as const },
    ],
  }],
};
const AT: WorkspaceAt = {
  at: at("09:00"),
  counts: { same: 5, changed: 2, deleted_since: 1, created_since: 1, total: 9 },
  notes: [
    { id: "n1", title_then: "演算法", title_now: "演算法", space_id: null, status: "changed", change: { added: 1, changed: 0, removed: 0, sections: [] } },
    { id: "n2", title_then: "作業系統", title_now: "作業系統", space_id: null, status: "changed", change: null },
    { id: "n3", title_then: "舊筆記", title_now: "舊筆記", space_id: null, status: "deleted_since", change: null },
    { id: "n4", title_then: "新筆記", title_now: "新筆記", space_id: null, status: "created_since", change: null },
  ],
};

beforeAll(async () => { await import("../components/OverviewPreview"); });
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  width = 600;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: width, height: 0 }) as DOMRect);
  setLocalePref("zh-TW");
  resetAppState({ data: noWorkspaceData });
  api.fetchActivity.mockResolvedValue(activityFixture());
  api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today), FEED_DAY], earlier_day: null });
  api.fetchDeleted.mockResolvedValue({ notes: [], older_cursor: null });
  rw.fetchWorkspaceAt.mockResolvedValue(AT);
});
afterEach(() => { cleanup(); setLocalePref("system"); localStorage.clear(); vi.restoreAllMocks(); });

const renderScreen = (online = true) => render(<WorkspaceHistory online={online} onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
/** The past day, picked on the chart. */
async function pastDay(online = true) {
  const view = renderScreen(online);
  fireEvent.click((await screen.findAllByRole("button", { name: /^\d+\/\d+，\d+ 次修改$/ }))[12]!);
  await screen.findByRole("button", { name: "那天的樣子" });
  return view;
}

describe("那天的樣子", () => {
  it("is offered on a past day's heading, not on today's, and asks for the end of that day", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    expect(screen.queryByRole("button", { name: "那天的樣子" })).toBeNull();
    fireEvent.click((await screen.findAllByRole("button", { name: /^\d+\/\d+，\d+ 次修改$/ }))[12]!);
    fireEvent.click(await screen.findByRole("button", { name: "那天的樣子" }));
    await screen.findByRole("dialog");
    expect(rw.fetchWorkspaceAt).toHaveBeenCalledWith(END_OF_DAY, null);
  });

  it("looks back to the end of the day as the server cut it, not this device's zone", async () => {
    // The server may cut days in another zone than the browser's (UTC vs Taipei): its end_at wins.
    const endAt = `${day}T15:59:59.999Z`;
    api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today), { ...FEED_DAY, end_at: endAt }], earlier_day: null });
    await pastDay();
    fireEvent.click(screen.getByRole("button", { name: "那天的樣子" }));
    await screen.findByRole("dialog");
    expect(rw.fetchWorkspaceAt).toHaveBeenCalledWith(endAt, null);
  });

  it("narrow: a full-screen dialog says how it differs from now and lists the three groups, not the notes that are the same", async () => {
    await pastDay();
    fireEvent.click(screen.getByRole("button", { name: "那天的樣子" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("跟現在比：之後改了 2 篇、新增 1 篇、刪了 1 篇")).toBeInTheDocument();
    const group = (name: string) => dialog.querySelector(`[data-group="${name}"]`)! as HTMLElement;
    expect(within(group("changed")).getByText("演算法")).toBeInTheDocument();
    expect(within(group("changed")).getByText("作業系統")).toBeInTheDocument();
    expect(within(group("deleted_since")).getByText("舊筆記")).toBeInTheDocument();
    expect(within(group("created_since")).getByText("新筆記")).toBeInTheDocument();
    expect(within(dialog).getByText("之後改過", { exact: false })).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|NODE_|\{"/); // no ids, event names or JSON
  });

  it("opening a note shows its paragraphs then against now", async () => {
    rw.fetchNoteAt.mockResolvedValue({
      id: "n1", status: "changed", title_then: "演算法", title_now: "演算法", deleted: false,
      markdown_then: "# 演算法\n\n舊的第三章\n", markdown_now: "# 演算法\n\n新的第三章\n\n多出來的一段\n",
    });
    await pastDay();
    fireEvent.click(screen.getByRole("button", { name: "那天的樣子" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /演算法/ }));
    expect(await within(dialog).findByText(/舊的第三章/)).toBeInTheDocument();
    expect(within(dialog).getByText(/新的第三章/)).toBeInTheDocument();
    expect(within(dialog).getByText(/多出來的一段/)).toBeInTheDocument();
    expect(rw.fetchNoteAt).toHaveBeenCalledWith("n1", END_OF_DAY, null);
  });

  it("wide: the preview takes the right column instead of a dialog", async () => {
    width = 1200;
    await pastDay();
    fireEvent.click(screen.getByRole("button", { name: "那天的樣子" }));
    expect(await screen.findByText("跟現在比：之後改了 2 篇、新增 1 篇、刪了 1 篇")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".wh-detail-pane .wh-rewind")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "關閉" }));
    await waitFor(() => expect(document.querySelector(".wh-rewind")).toBeNull());
    expect(screen.getByTestId("note-pane")).toBeInTheDocument();
  });
});

describe("回到這之前", () => {
  const menuOf = (row: HTMLElement) => within(row.closest("li")!).getByRole("button", { name: "更多動作" });

  it("a row's ⋯ menu looks at the moment just before that note's first save of the day", async () => {
    await pastDay();
    const row = screen.getAllByRole("button", { name: /作業系統/ }).find((b) => !b.closest("article"))!;
    fireEvent.click(menuOf(row));
    fireEvent.click(await screen.findByRole("menuitem", { name: "回到這之前" }));
    await screen.findByRole("dialog");
    expect(rw.fetchWorkspaceAt).toHaveBeenCalledWith(new Date(Date.parse(at("13:00")) - 1).toISOString(), null);
  });

  it("an AI card has a quiet link that looks at the moment before the run started", async () => {
    await pastDay();
    const card = screen.getByRole("article", { name: /Claude/ });
    fireEvent.click(within(card).getByRole("button", { name: "回到這之前" }));
    await screen.findByRole("dialog");
    expect(rw.fetchWorkspaceAt).toHaveBeenCalledWith(new Date(Date.parse(at("11:00")) - 1).toISOString(), null);
  });

  it("newer rows fade and say they will be undone, a line marks the cut, and closing the preview puts it all back", async () => {
    width = 1200;
    await pastDay();
    const row = screen.getAllByRole("button", { name: /演算法/ }).find((b) => !b.closest("article"))!;   // saved 10:00–10:30
    fireEvent.click(menuOf(row));
    fireEvent.click(await screen.findByRole("menuitem", { name: "回到這之前" }));
    await screen.findByText("跟現在比：之後改了 2 篇、新增 1 篇、刪了 1 篇");

    const faded = [...document.querySelectorAll(".wh-after-cut")];
    // both note rows (the cut is before 10:00), the AI run (11:00) and the rewind card (12:00) are newer
    expect(faded).toHaveLength(4);
    expect(faded.every((el) => within(el as HTMLElement).queryByText("會被復原"))).toBe(true);
    expect(screen.getByRole("separator", { name: "還原到這裡" })).toBeInTheDocument();
    expect(document.querySelector(".wh-cut-banner")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "關閉" }));
    await waitFor(() => expect(document.querySelectorAll(".wh-after-cut")).toHaveLength(0));
    expect(screen.queryByRole("separator", { name: "還原到這裡" })).toBeNull();
    expect(document.querySelector(".wh-cut-banner")).toBeNull();
  });
});

describe("還原到這時", () => {
  async function confirm(online = true) {
    await pastDay(online);
    fireEvent.click(screen.getByRole("button", { name: "那天的樣子" }));
    const preview = await screen.findByRole("dialog");
    await within(preview).findByText("跟現在比：之後改了 2 篇、新增 1 篇、刪了 1 篇");
    return preview;
  }

  it("the main button is disabled offline", async () => {
    const preview = await confirm(false);
    expect(within(preview).getByRole("button", { name: "還原到這時" })).toBeDisabled();
    expect(within(preview).getByText("目前離線，還原需要連線。")).toBeInTheDocument();
  });

  it("shows three checked lists, the scope in plain words, and sends exactly what stays checked", async () => {
    writer.rewindWorkspace.mockResolvedValue({ rewind_id: "rw-9", restored: ["n1"], undeleted: ["n3"], deleted: ["n4"], stale: [], unwritable: [], skipped: [] });
    const preview = await confirm();
    fireEvent.click(within(preview).getByRole("button", { name: "還原到這時" }));
    const dialogs = await screen.findAllByRole("dialog");
    const sheet = dialogs[dialogs.length - 1]!;
    expect(within(sheet).getByRole("heading", { name: /^還原到 / })).toBeInTheDocument();
    expect(within(sheet).getByText("還原內容 2 篇")).toBeInTheDocument();
    expect(within(sheet).getByText("救回刪掉的 1 篇")).toBeInTheDocument();
    expect(within(sheet).getByText("之後新增的 1 篇（移到最近刪除，隨時可救回）")).toBeInTheDocument();
    expect(within(sheet).getByText(/位置和標籤維持現在的樣子/)).toBeInTheDocument();
    expect(within(sheet).getByText(/只還原筆記的內容/)).toBeInTheDocument();
    for (const box of within(sheet).getAllByRole("checkbox")) expect(box).toBeChecked();

    fireEvent.click(within(sheet).getByRole("checkbox", { name: "作業系統" }));      // not this one
    fireEvent.click(within(sheet).getByRole("button", { name: "還原 3 篇" }));
    await waitFor(() => expect(writer.rewindWorkspace).toHaveBeenCalledTimes(1));
    expect(writer.rewindWorkspace).toHaveBeenCalledWith({ t: END_OF_DAY, restore_ids: ["n1"], undelete_ids: ["n3"], delete_ids: ["n4"] });
    expect(await screen.findByText("已還原 3 篇")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.fetchFeed).toHaveBeenCalledTimes(2));   // the feed read again
  });

  it("a refused rewind keeps the dialog and the choices, and says why in plain words", async () => {
    writer.rewindWorkspace.mockRejectedValue(new ApiError(400, JSON.stringify({ error: "rewind_too_many" })));
    const preview = await confirm();
    fireEvent.click(within(preview).getByRole("button", { name: "還原到這時" }));
    const dialogs = await screen.findAllByRole("dialog");
    const sheet = dialogs[dialogs.length - 1]!;
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "演算法" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "還原 3 篇" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("一次最多還原 2000 篇");
    expect(within(sheet).getByRole("checkbox", { name: "演算法" })).not.toBeChecked();
    expect(within(sheet).getByRole("button", { name: "還原 3 篇" })).toBeEnabled();
  });
});

describe("the rewind card", () => {
  it("shows what was restored, where, and undoes it with the notes the person keeps checked", async () => {
    writer.undoRewind.mockResolvedValue({ undone: ["n3", "n4"], conflicts: [], kept: [], skipped: [] });
    await pastDay();
    const card = screen.getByRole("article", { name: /^還原到 .* · 2 篇$/ });
    expect(within(card).getByText("舊筆記")).toBeInTheDocument();
    expect(within(card).getByText("已救回")).toBeInTheDocument();
    expect(within(card).getByText("已移到最近刪除")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/rw-1|rewind_id/);
    fireEvent.click(within(card).getByRole("button", { name: "復原這次還原" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "復原 2 篇" }));
    await waitFor(() => expect(writer.undoRewind).toHaveBeenCalledWith("rw-1", ["n3", "n4"]));
    expect(await screen.findByText("已復原 2 篇的還原")).toBeInTheDocument();
    expect(within(card).getByText(/已復原/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "復原這次還原" })).toBeNull();
  });

  it("an undo that left conflicts and later edits says so, and points to the inbox", async () => {
    writer.undoRewind.mockResolvedValue({ undone: ["n3"], conflicts: ["n3"], kept: ["n4"], skipped: [] });
    await pastDay();
    const card = screen.getByRole("article", { name: /^還原到/ });
    fireEvent.click(within(card).getByRole("button", { name: "復原這次還原" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "復原 2 篇" }));
    expect(await within(card).findByText("1 篇有段落兩邊都改過，放在收件匣「等你決定」")).toBeInTheDocument();
    expect(within(card).getByText("1 篇在還原之後又改過，維持現在的樣子")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "前往收件匣" })).toBeInTheDocument();
  });

  it("the undo is disabled offline", async () => {
    await pastDay(false);
    const card = screen.getByRole("article", { name: /^還原到/ });
    expect(within(card).getByRole("button", { name: "復原這次還原" })).toBeDisabled();
  });
});

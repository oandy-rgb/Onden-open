// The History screen's space filter: the 「全部空間 ▾」 menu, the remembered choice, the `space`
// each read carries, the space name beside a note, and the AI card narrowed to one space.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceHistory } from "../components/history";
import * as historyApi from "../lib/history/workspaceHistoryApi";
import type { Feed } from "@onden/contract";
import { bindAccountStorage } from "../lib/accountStorage";
import { setLocalePref } from "../lib/i18n";
import { getPref, PREFS, setPref } from "../lib/prefs";
import type { Space } from "../lib/spaces";
import { activityFixture, feedDayFixture, feedFixture } from "./workspaceHistoryFixtures";
import { todayId } from "../lib/localDate";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

vi.mock("../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(), fetchFeed: vi.fn(), fetchDeleted: vi.fn(),
}));
const writer = vi.hoisted(() => ({ undoAgentRun: vi.fn(), redoAgentRun: vi.fn(), rewindWorkspace: vi.fn(), undoRewind: vi.fn() }));
vi.mock("../lib/data", async (original) => ({ ...await original<typeof import("../lib/data")>(), historyWriter: writer }));
const spaceState = vi.hoisted(() => ({ spaces: [] as unknown[], loaded: true }));
vi.mock("../lib/spaces", async (original) => ({
  ...await original<typeof import("../lib/spaces")>(),
  useSpaces: () => spaceState,
}));

// The slider itself is NoteHistory's own tests; here only which note the right column is given.
vi.mock("../components/history/WorkspaceHistoryNotePane", () => ({
  default: (p: { noteId: string; day: string }) => <div data-testid="note-pane">{p.noteId}@{p.day}</div>,
}));

const api = vi.mocked(historyApi);
const today = todayId();

const space = (id: string, name: string, extra: Partial<Space> = {}): Space => ({
  id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...extra,
});
const ME = space("sp-me", "我的", { kind: "personal" });
const COURSE = space("sp-course", "課程");

function useSpaceList(...spaces: Space[]) { spaceState.spaces = spaces; spaceState.loaded = true; }
function renderScreen() {
  return render(<WorkspaceHistory online onOpenNote={vi.fn()} onOpenNoteHistory={vi.fn()} onOpenInbox={vi.fn()} />);
}
/** The menu's own button: note rows carry a space name too, so it is told apart by what it opens. */
const menuButton = () => screen.queryAllByRole("button").find((b) => b.getAttribute("aria-haspopup") === "menu" && b.classList.contains("space-filter")) ?? null;
const menuLabel = async () => { await waitFor(() => expect(menuButton()).not.toBeNull()); return menuButton()!.textContent; };
async function choose(name: string) {
  await waitFor(() => expect(menuButton()).not.toBeNull());
  fireEvent.click(menuButton()!);
  fireEvent.click(await screen.findByRole("menuitemradio", { name }));
}

/** Today's feed: n1 in the personal space, n4 in 課程, n9 (yesterday) in no space; the AI run touches n1, n2 (課程), n3. */
function mixedFeed(): Feed {
  const feed = structuredClone(feedFixture()); // RUN is shared between tests
  const day = feed.days[0]!;
  day.notes[0]!.space_id = "sp-me";
  day.notes[1]!.space_id = "sp-course";
  day.agent_runs[0]!.notes[0]!.space_id = "sp-me";
  day.agent_runs[0]!.notes[1]!.space_id = "sp-course";
  return feed;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  bindAccountStorage("unit-test-account", "");
  setLocalePref("zh-TW");
  useSpaceList(ME, COURSE);
  api.fetchActivity.mockResolvedValue(activityFixture());
  api.fetchFeed.mockResolvedValue(mixedFeed());
  api.fetchDeleted.mockResolvedValue({ notes: [
    { id: "d1", title: "舊計畫", deleted_at: "2026-10-23T14:05:00Z", space_id: "sp-course", blank: false },
    { id: "d2", title: "無空間", deleted_at: "2026-10-23T14:06:00Z", space_id: null, blank: false },
  ], older_cursor: null });
});
afterEach(() => { cleanup(); setLocalePref("system"); localStorage.clear(); });

describe("WorkspaceHistory: the space menu", () => {
  it("is offered only when the person can read two or more spaces", async () => {
    useSpaceList(ME);
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    expect(menuButton()).toBeNull();
    cleanup();
    useSpaceList();
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    expect(menuButton()).toBeNull();
    cleanup();
    useSpaceList(ME, COURSE);
    renderScreen();
    expect(await menuLabel()).toBe("全部空間");
  });

  it("lists 全部空間 and each space by its name, and reads again with the chosen space", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    expect(api.fetchFeed).toHaveBeenLastCalledWith(today, 14, null);
    fireEvent.click(menuButton()!);
    expect(within(screen.getByRole("menu")).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["全部空間", "只有我", "課程"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "課程" }));
    await waitFor(() => expect(api.fetchFeed).toHaveBeenLastCalledWith(today, 14, "sp-course"));
    expect(api.fetchActivity).toHaveBeenLastCalledWith(14, undefined, "sp-course");
    expect(menuButton()!.textContent).toBe("課程");
  });

  it("narrows 最近刪除 as well", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("tab", { name: "最近刪除" }));
    await screen.findByText("舊計畫");
    expect(api.fetchDeleted).toHaveBeenLastCalledWith(undefined, null);
    await choose("課程");
    await waitFor(() => expect(api.fetchDeleted).toHaveBeenLastCalledWith(undefined, "sp-course"));
  });

  it("remembers the choice, and a remembered space that is gone counts as all spaces", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    await choose("只有我");
    expect(getPref(PREFS.historySpace)).toBe("sp-me");
    cleanup();

    renderScreen();
    expect(await menuLabel()).toBe("只有我");
    await waitFor(() => expect(api.fetchFeed).toHaveBeenLastCalledWith(today, 14, "sp-me"));
    cleanup();

    setPref(PREFS.historySpace, "sp-gone");
    api.fetchFeed.mockClear();
    renderScreen();
    expect(await menuLabel()).toBe("全部空間");
    await screen.findByRole("heading", { name: /^今天/ });
    expect(api.fetchFeed).toHaveBeenLastCalledWith(today, 14, null);
  });

  it("goes back to all spaces when only one is left to read", async () => {
    setPref(PREFS.historySpace, "sp-course");
    useSpaceList(ME);
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    expect(api.fetchFeed).toHaveBeenLastCalledWith(today, 14, null);
    expect(menuButton()).toBeNull();
  });
});

describe("WorkspaceHistory: the space beside a note", () => {
  it("names the space of each note in 全部空間, and not for a note in no space", async () => {
    renderScreen();
    const row = (await screen.findAllByRole("button", { name: /演算法/ })).find((b) => !b.closest("article"))!.closest("li")!;
    expect(within(row).getByText("只有我")).toHaveClass("wh-note-space");
    expect(within(screen.getByRole("button", { name: /新筆記/ }).closest("li")!).getByText("課程")).toBeInTheDocument();
    cleanup();

    api.fetchFeed.mockResolvedValue({ days: [feedDayFixture(today, { agent_runs: [] })], earlier_day: null });
    renderScreen();
    const plain = (await screen.findByRole("button", { name: /演算法/ })).closest("li")!;
    expect(plain.querySelector(".wh-note-space")).toBeNull();
  });

  it("shows no name once one space is chosen: every row would say the same", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: /^今天/ });
    expect(document.querySelectorAll(".wh-note-space").length).toBeGreaterThan(0);
    await choose("課程");
    await waitFor(() => expect(api.fetchFeed).toHaveBeenLastCalledWith(today, 14, "sp-course"));
    await screen.findByRole("heading", { name: /^今天/ });
    expect(document.querySelector(".wh-note-space")).toBeNull();
  });

  it("names the space of the notes in an AI card and in 最近刪除", async () => {
    renderScreen();
    const card = await screen.findByRole("article");
    expect(within(card.querySelector("ul")!.querySelectorAll("li")[1]!).getByText("課程")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "最近刪除" }));
    const deleted = (await screen.findByText("舊計畫")).closest("li")!;
    expect(within(deleted).getByText("課程")).toBeInTheDocument();
    expect(within((await screen.findByText("無空間")).closest("li")!).queryByText("課程")).toBeNull();
  });
});

describe("WorkspaceHistory: an AI card in one space", () => {
  it("lists only the notes the server sent for that space, in the card and in the undo dialog", async () => {
    api.fetchFeed.mockImplementation(async (_until, _days, spaceId) => {
      const feed = mixedFeed();
      if (spaceId === "sp-course") feed.days[0]!.agent_runs[0]!.notes = feed.days[0]!.agent_runs[0]!.notes.filter((n) => n.space_id === "sp-course");
      return feed;
    });
    writer.undoAgentRun.mockResolvedValue({ undone: ["n2"], conflicts: [] });
    renderScreen();
    expect(within(await screen.findByRole("article")).getAllByRole("listitem")).toHaveLength(3);
    await choose("課程");
    await waitFor(() => expect(within(screen.getByRole("article")).getAllByRole("listitem")).toHaveLength(1));
    const card = screen.getByRole("article");
    expect(within(card).getByText("作業系統")).toBeInTheDocument();
    expect(within(card).queryByText("演算法")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "復原這次修改" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialog).getByRole("checkbox", { name: "作業系統" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: /^復原 1 篇/ }));
    await waitFor(() => expect(writer.undoAgentRun).toHaveBeenCalledWith("run-1", ["n2"]));
  });
});

describe("WorkspaceHistory: two columns", () => {
  it("a row picked the moment the list appears stays picked (the default row does not overwrite it)", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 1200, height: 0 }) as DOMRect);
    // Click inside the commit that first shows the list, before its effects run:
    // the effect that chooses the first row by default used to queue after the click and win.
    let clicked = false;
    const watch = new MutationObserver(() => {
      const row = screen.queryAllByRole("button", { name: /新筆記/ })[0];
      if (clicked || !document.querySelector('[data-testid="note-pane"]') || !row) return;
      clicked = true;
      fireEvent.click(row);
    });
    watch.observe(document.body, { childList: true, subtree: true });
    renderScreen();
    await waitFor(() => expect(clicked).toBe(true));
    watch.disconnect();
    await waitFor(() => expect(screen.getByTestId("note-pane")).toHaveTextContent(`n4@${today}`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("note-pane")).toHaveTextContent(`n4@${today}`);
  });

  it("drops the open note when the space changes and opens the first note of the new one", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 1200, height: 0 }) as DOMRect);
    api.fetchFeed.mockImplementation(async (_until, _days, spaceId) => {
      const feed = mixedFeed();
      if (spaceId === "sp-course") feed.days[0]!.notes = feed.days[0]!.notes.filter((n) => n.space_id === "sp-course");
      return feed;
    });
    renderScreen();
    expect(await screen.findByTestId("note-pane")).toHaveTextContent(`n1@${today}`);
    fireEvent.click(screen.getAllByRole("button", { name: /新筆記/ })[0]!);
    await waitFor(() => expect(screen.getByTestId("note-pane")).toHaveTextContent(`n4@${today}`));
    await choose("只有我");
    // n1 is the only note left in this space; the pick of the old space (n4) is not carried over
    await waitFor(() => expect(api.fetchFeed).toHaveBeenLastCalledWith(today, 14, "sp-me"));
    await waitFor(() => expect(screen.getByTestId("note-pane")).toHaveTextContent(`n1@${today}`));
  });
});

// Daily notes (日記) are an optional module (modules/daily, the day-notes
// shell feature of lib/shellFeatures). Off, nothing starts a day note: openToday refuses, and every
// caller takes its own non-day path. The parent-note setting decides where a
// NEW day note goes; finding today's note never depends on it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The account-preference calls (lib/dayNoteParentStore) go to this fake server.
let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});

const sendOrQueue = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await sendOrQueue(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  upsertNode: async () => {}, removeNode: async () => {}, upsertAttribute: async () => {},
}));
const apiCall = vi.fn();
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: (path: string, init?: RequestInit) => apiCall(path, init),
}));
const space = vi.hoisted(() => ({ id: "11111111-2222-4333-8444-555555555555" as string | null, loads: null as string | null }));
vi.mock("../lib/spaces", async (original) => ({
  ...await original<typeof import("../lib/spaces")>(),
  personalSpaceId: () => space.id,
  // The server's answer to the spaces request (null: offline, nothing arrives).
  refreshSpaces: vi.fn(async () => { if (space.loads) space.id = space.loads; }),
}));

import QuickCapture from "../modules/capture/QuickCapture";
import { captureDestinationPref } from "../modules/capture/captureDestination";
import { INBOX_TAG_ID, captureProps } from "./helpers/captureProps";
import HomeStart from "../components/HomeStart";
import { arrangeNavigation, getMoreNavigationGroups } from "../hooks/shellNavigation";
import { importedFeatures } from "../hooks/useImportedFeatures";
import { noWorkspaceData, type Bootstrap, type ContentNode } from "../lib/api";
import { getAppState, resetAppState, setBootstrapped, setData, setOnline } from "../lib/appStore";
import { dailyNotesEnabled, dailyNotesEnabledIn } from "../lib/dayNode";
import { DailyNotesDisabledError, InvalidDayNoteDateError, PersonalSpaceUnknownError, dayNoteId, dayNotesOutside, makeDayNotes, usableDayNoteParent } from "../lib/data/dayNotes";
import type { DataCtx } from "../lib/data/types";
import { useNodeCreation } from "../hooks/useNodeCreation";
import { useDayNoteWrites } from "../hooks/useDayNoteWrites";
import { MODULES, MODULE_SETTINGS, moduleFilterFor } from "../modules";
import DayNoteParentSetting from "../modules/daily/DayNoteParentSetting";
import { bindAccountStorage } from "../lib/accountStorage";
import { dayNotes, dayNoteParentSetting, reads } from "../lib/data";
import { dayNoteParentStore } from "../lib/data/dayNoteParentStore";
import { todayId } from "../lib/localDate";

const DAILY_MODULE = "daily";

bindAccountStorage("daily-user", "http://localhost");

const SPACE = "11111111-2222-4333-8444-555555555555";
const today = () => todayId();
const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", space_id: SPACE, ...extra,
});
const nodePosts = () => sendOrQueue.mock.calls.filter(([method, path]) => method === "POST" && path === "/api/nodes")
  .map(([, , body]) => JSON.parse(body as string) as { id: string; title: string; markdown: string; parent_id?: string | null });

function device(nodes: ContentNode[], modules: string[] | null, parentSetting: (() => string | null) | "account" = () => null, online = true) {
  let state: Bootstrap = { ...noWorkspaceData, nodes, workspace: { ...noWorkspaceData.workspace, modules } };
  const ctx: DataCtx = {
    get data() { return state; }, online,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  // "account": the real setting (the account's pref, heard from the fake server).
  return parentSetting === "account" ? makeDayNotes(ctx) : makeDayNotes(ctx, { parentSetting });
}

const setModules = (modules: string[] | null) =>
  setData((s) => ({ ...s, workspace: { ...s.workspace, modules } }));

function creationHook() {
  const setSelectedId = vi.fn();
  const { result } = renderHook(() => useNodeCreation({
    data: getAppState().data, createNodeRaw: vi.fn(), refresh: vi.fn(), draftTitle: "", setCreateOpen: vi.fn(),
    activeCanvas: null, addToActiveCanvas: vi.fn(), setSelectedId, setMode: vi.fn(), openNote: vi.fn(), openNewTag: vi.fn(),
  }));
  return { result, setSelectedId };
}

beforeEach(() => {
  serverPrefs = {};
  sendWrite.mockReset().mockImplementation(async (_m: string, path: string, body: { value: unknown }) => { serverPrefs[path.split("/").pop()!] = body.value; return { value: body.value }; });
  resetAppState();
  setOnline(true);
  space.id = SPACE;
  space.loads = null;
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  apiCall.mockReset().mockResolvedValue({});
});

describe("the daily notes module", () => {
  it("is registered in the module library under the backend's id", () => {
    expect(MODULES.some((m) => m.id === DAILY_MODULE && m.library.title === "Daily notes")).toBe(true);
    expect(DAILY_MODULE).toBe("daily");
  });

  it("is on for a workspace from before the library (no list) and for a list that has it; off otherwise", () => {
    expect(dailyNotesEnabledIn(undefined)).toBe(true);
    expect(dailyNotesEnabledIn(null)).toBe(true);
    expect(dailyNotesEnabledIn(["canvas", "daily"])).toBe(true);
    expect(dailyNotesEnabledIn(["canvas"])).toBe(false);
    expect(dailyNotesEnabledIn([])).toBe(false);
    setModules(["canvas"]);
    expect(dailyNotesEnabled()).toBe(false);
    setModules(["daily"]);
    expect(dailyNotesEnabled()).toBe(true);
  });
});

describe("openToday with the module off", () => {
  it("refuses to start a day note and only-looking finds none", async () => {
    const notes = device([note(today())], ["canvas"]);
    await expect(notes.openToday()).rejects.toBeInstanceOf(DailyNotesDisabledError);
    await expect(notes.openToday({ create: { markdown: "x" } })).rejects.toBeInstanceOf(DailyNotesDisabledError);
    await expect(notes.openDay("2026-10-01")).rejects.toBeInstanceOf(DailyNotesDisabledError);
    expect(await notes.openToday({ create: false })).toBeNull();
    expect(notes.enabled()).toBe(false);
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe("openDay's date", () => {
  it("refuses anything but a real YYYY-MM-DD date, looking or starting", async () => {
    const notes = device([note("2026-10-01")], ["daily"]);
    for (const bad of ["2026-13-01", "2026-02-30", "2026-10-1", "2026-10-01T00:00", "2026-10-01 ", "", "today", "../2026-10-01"]) {
      await expect(notes.openDay(bad), bad).rejects.toBeInstanceOf(InvalidDayNoteDateError);
      expect(await notes.openDay(bad, { create: false }), bad).toBeNull();
    }
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(await notes.openDay("2026-10-01", { create: false })).toMatchObject({ created: false, node: { id: "2026-10-01" } });
  });
});

describe("the parent-note setting", () => {
  it("puts a new day note under the chosen parent, with the same (space, date) id", async () => {
    const notes = device([note("journal")], ["daily"], () => "journal");
    const opened = await notes.openToday();
    const [posted] = nodePosts();
    expect(posted).toMatchObject({ id: dayNoteId(SPACE, today()), title: today(), parent_id: "journal" });
    expect(opened).toMatchObject({ created: true });
  });

  it("is unset by default: top level, as before", async () => {
    await device([], ["daily"]).openToday();
    expect(nodePosts()[0]!.parent_id).toBeUndefined();
  });

  it("is ignored when the parent is gone, hidden, trashed or in another space", async () => {
    for (const parent of [
      null,
      note("journal", { hidden: true }),
      note("journal", { deleted_at: "2026-10-01T00:00:00Z" }),
      note("journal", { space_id: "other-space" }),
    ]) {
      sendOrQueue.mockClear();
      await device(parent ? [parent] : [], ["daily"], () => "journal").openToday();
      expect(nodePosts()[0]!.parent_id).toBeUndefined();
    }
    expect(usableDayNoteParent([note("journal")], "journal", SPACE)).toBe("journal");
    expect(usableDayNoteParent([note("journal")], null, SPACE)).toBeNull();
  });

  // Unknown is a device that never heard the server (lib/spaces.ts keeps the list in the local copy): no day note is
  // started rather than one at the top level under a random id (2026-11-21).
  it("starts nothing while the personal space is unknown", async () => {
    space.id = null;
    for (const parent of [note("journal"), note("journal", { space_id: "other-space" }), note("journal", { space_id: null })]) {
      sendOrQueue.mockClear();
      expect(usableDayNoteParent([parent], "journal", null)).toBeNull();
      await expect(device([parent], ["daily"], () => "journal").openToday()).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
      expect(nodePosts()).toEqual([]);
    }
  });

  // 2026-10-29 phone: a cold start lands on today from the local copy before
  // the spaces request answers; the note went to the top level, random id.
  it("waits for the spaces on a cold start, then uses the parent and the (space, date) id", async () => {
    space.id = null;
    space.loads = SPACE;
    await device([note("journal")], ["daily"], () => "journal").openToday();
    expect(nodePosts()[0]).toMatchObject({ id: dayNoteId(SPACE, today()), title: today(), parent_id: "journal" });
  });

  it("never stops an existing day note from being found, wherever it lives", async () => {
    // Made before the setting (top level) and under another parent.
    for (const existing of [note(today()), note(today(), { parent_id: "somewhere-else" })]) {
      sendOrQueue.mockClear();
      const opened = await device([note("journal"), existing], ["daily"], () => "journal").openToday();
      expect(opened).toMatchObject({ created: false, node: { id: today() } });
      expect(sendOrQueue).not.toHaveBeenCalled();
    }
  });

  // 2026-10-31 tablet: a device whose copy of the setting was empty (new, or
  // cleared) started today under the top level before the server answered.
  it("waits for the account's setting before starting a note when this device has not heard it yet", async () => {
    dayNoteParentStore.forget();
    serverPrefs.dayNoteParent = "journal";
    await device([note("journal")], ["daily"], "account").openToday();
    expect(nodePosts()[0]).toMatchObject({ id: dayNoteId(SPACE, today()), parent_id: "journal" });
  });

  it("offline, uses this device's copy and does not wait for the server", async () => {
    dayNoteParentStore.forget();
    dayNoteParentStore.save("journal");
    dayNoteParentStore.forget();
    serverPrefs.dayNoteParent = "elsewhere";
    const myPref = vi.mocked(reads.people.myPref);
    myPref.mockClear();
    await device([note("journal")], ["daily"], "account", false).openToday();
    expect(myPref).not.toHaveBeenCalled();
    expect(nodePosts()[0]).toMatchObject({ parent_id: "journal" });
  });

  it("puts the 任務 note under the parent while the module is on, finds it there and starts no second", async () => {
    const notes = device([note("journal")], ["daily"], () => "journal");
    await notes.openTasksNote();
    expect(nodePosts()[0]).toMatchObject({ id: dayNoteId(SPACE, "任務"), title: "任務", parent_id: "journal" });
    sendOrQueue.mockClear();
    const there = note(dayNoteId(SPACE, "任務"), { title: "任務", parent_id: "journal" });
    expect(await device([note("journal"), there], ["daily"], () => "journal").openTasksNote()).toMatchObject({ created: false, node: { id: there.id } });
    expect(sendOrQueue).not.toHaveBeenCalled();
  });

  it("keeps the 任務 note at the top level while the module is off", async () => {
    await device([note("journal")], ["canvas"], () => "journal").openTasksNote();
    expect(nodePosts()[0]!.parent_id).toBeUndefined();
  });

  it("starts a shared space's 任務 note only when asked, at that space's top level, and finds it again", async () => {
    const SHARED = "99999999-2222-4333-8444-555555555555";
    const notes = device([note("journal")], ["daily"], () => "journal");
    expect(nodePosts()).toEqual([]); // nothing is made beforehand
    await notes.openTasksNote(SHARED);
    expect(nodePosts()).toHaveLength(1);
    expect(nodePosts()[0]).toMatchObject({ id: dayNoteId(SHARED, "任務"), title: "任務", space_id: SHARED });
    expect(nodePosts()[0]!.parent_id).toBeUndefined(); // the diary parent is the personal space's
    sendOrQueue.mockClear();
    const there = note(dayNoteId(SHARED, "任務"), { title: "任務", space_id: SHARED });
    // The personal 任務 note and a shared one are different notes.
    const mine = note(dayNoteId(SPACE, "任務"), { title: "任務" });
    const found = device([mine, there], ["daily"]);
    expect(await found.openTasksNote(SHARED)).toMatchObject({ created: false, node: { id: there.id } });
    expect(await found.openTasksNote()).toMatchObject({ created: false, node: { id: mine.id } });
    expect(sendOrQueue).not.toHaveBeenCalled();
  });

  // Quick-add and capture: a task with no note of its own (dayNotes.openTaskHome).
  it("homes a task: personal → today's diary (module on) or the 任務 note; a shared space → its 任務 note", async () => {
    const SHARED = "99999999-2222-4333-8444-555555555555";
    expect(await device([note("journal")], ["daily"]).openTaskHome(SPACE)).toMatchObject({ node: { id: dayNoteId(SPACE, today()) } });
    expect(await device([note("journal")], ["daily"]).openTaskHome(undefined)).toMatchObject({ node: { id: dayNoteId(SPACE, today()) } });
    expect(await device([note("journal")], ["canvas"]).openTaskHome(SPACE)).toMatchObject({ node: { id: dayNoteId(SPACE, "任務") } });
    expect(await device([note("journal")], ["daily"]).openTaskHome(SHARED)).toMatchObject({ node: { id: dayNoteId(SHARED, "任務") } });
    space.id = null; // never heard the server: no guessed home, for any space
    for (const where of [undefined, SPACE, SHARED]) {
      sendOrQueue.mockClear();
      await expect(device([note("journal")], ["daily"]).openTaskHome(where)).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
      await expect(device([note("journal")], ["canvas"]).openTasksNote(where)).rejects.toBeInstanceOf(PersonalSpaceUnknownError);
      expect(nodePosts()).toEqual([]);
    }
  });

  it("does not take another space's 任務 note for the shared one", async () => {
    const SHARED = "99999999-2222-4333-8444-555555555555";
    const mine = note(dayNoteId(SPACE, "任務"), { title: "任務" });
    expect(await device([mine], null).openTasksNote(SHARED)).toMatchObject({ created: true, node: { id: dayNoteId(SHARED, "任務") } });
  });

  it("offers to move future days' notes and the 任務 note too", () => {
    const nodes = [
      note("journal"), note("2999-11-13"), note("2999-11-15", { parent_id: "journal" }),
      note("tasks", { title: "任務", slug: "tasks-1" }), note("2026-10-01"),
    ];
    expect(dayNotesOutside(nodes, "journal", SPACE).map((n) => n.id)).toEqual(["2026-10-01", "2999-11-13", "tasks"]);
  });

  it("lists the day notes outside the parent, never the parent or what it sits under", () => {
    const nodes = [
      note("2026-10-02"),
      note("2026-10-01", { parent_id: "elsewhere" }),
      note("2026-10-03", { parent_id: "journal" }), // already there
      note("2026-09-30", { space_id: "shared" }), // not this person's
      note("2026-09-29", { deleted_at: "2026-10-01T00:00:00Z" }),
      note("Groceries"),
      note("2026-09-01"), note("journal", { parent_id: "2026-09-01" }), // the parent sits under a day note
    ];
    expect(dayNotesOutside(nodes, "journal", SPACE).map((n) => n.id)).toEqual(["2026-10-01", "2026-10-02"]);
  });
});

describe("callers with the module off", () => {
  beforeEach(() => setModules(["canvas"]));

  it("quick capture set to today's journal goes to the inbox while the module is off", async () => {
    captureDestinationPref.store.save("today");
    render(<QuickCapture {...captureProps({ online: false })} initialDraft="a thought" />);
    expect(screen.getByRole("button", { name: "Goes to: Inbox" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const posts = nodePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ title: "a thought", parent_id: null, tag_ids: [INBOX_TAG_ID] });
  });

  it("quick capture set to today's journal goes there while the module is on", () => {
    setModules(["daily"]);
    captureDestinationPref.store.save("today");
    render(<QuickCapture {...captureProps({ online: false })} initialDraft="a thought" />);
    expect(screen.getByRole("button", { name: "Goes to: Today's journal" })).toBeTruthy();
  });

  it("the agenda quick-add gives the task its own top-level note, not a day note", async () => {
    const addTask = vi.fn(async () => ({}));
    const agenda = renderHook(() => useDayNoteWrites({ addTaskRaw: addTask as never, openDailyNote: vi.fn() }));
    await act(() => agenda.result.current.createAgendaTask("Call dentist", { when: "2026-10-20" }));
    const posts = nodePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.title).toBe("Call dentist");
    expect(posts[0]!.parent_id).toBeUndefined();
    expect(addTask).toHaveBeenCalledWith(posts[0]!.id, "Call dentist", { when: "2026-10-20" });
  });

  it("the Today command (⌘⇧D, palette) and the mood picker start nothing", async () => {
    const { result, setSelectedId } = creationHook();
    let opened: string | null = "x";
    await act(async () => { opened = await result.current.openDailyNote(); });
    expect(opened).toBeNull();
    expect(setSelectedId).not.toHaveBeenCalled();
    const writes = renderHook(() => useDayNoteWrites({ addTaskRaw: vi.fn() as never, openDailyNote: result.current.openDailyNote }));
    await act(() => writes.result.current.setTodayMood("🙂"));
    expect(sendOrQueue).not.toHaveBeenCalled();
  });

  it("the Daily note template does nothing", async () => {
    const { result, setSelectedId } = creationHook();
    await act(() => result.current.create("template", { templateId: "daily" }));
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(setSelectedId).not.toHaveBeenCalled();
  });

  it("the home strip hides the Today button, streak and mood picker", () => {
    const props = {
      homeNodeId: "home", nodes: [note(today())], tasks: [], pinnedTags: [],
      onOpenNode: vi.fn(), onOpenToday: vi.fn(), onOpenTagView: vi.fn(), onSetTodayMood: vi.fn(),
    };
    const { unmount } = render(<HomeStart {...props} />);
    expect(screen.queryByText("Open today's note")).toBeNull();
    expect(screen.queryByRole("group", { name: "Today's mood" })).toBeNull();
    unmount();
    setModules(["daily"]);
    render(<HomeStart {...props} />);
    expect(screen.getByText("Open today's note")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Today's mood" })).toBeTruthy();
  });

  it("the More sheet lists 日記 as a feature only while it is imported, and never a core Today row", () => {
    const ids = (modules: string[]) => {
      const features = importedFeatures(moduleFilterFor(modules), []);
      const nav = arrangeNavigation({ mode: "notes" }, { setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() }, features, null);
      return getMoreNavigationGroups({}, nav.phoneMore).flatMap((g) => g.items.map((i) => i.id));
    };
    // There is no core Today row (the 今天 page is gone, 2026-11-18): only the 日記 row follows the module.
    expect(ids([])).not.toContain("today");
    expect(ids([])).not.toContain(DAILY_MODULE);
    expect(ids([DAILY_MODULE])).not.toContain("today");
    expect(ids([DAILY_MODULE])).toContain(DAILY_MODULE);
  });
});

describe("the parent-note setting screen", () => {
  const ctx = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() };
  beforeEach(() => { dayNoteParentSetting.set(null); setModules(["daily"]); });

  it("is one of the daily module's settings on its page, (the hour a day starts at is on Settings › Date and time)", () => {
    expect(MODULE_SETTINGS.filter((def) => def.moduleId === DAILY_MODULE).map((def) => def.id)).toEqual(["daily.parent_note"]);
  });

  it("picks a note by search; openToday then starts today's note under it; clearing goes back to the top level", async () => {
    setData((s) => ({ ...s, nodes: [note("Journal"), note("Shared journal", { space_id: "shared" }), note("2026-10-01")] }));
    render(<DayNoteParentSetting ctx={ctx} />);
    expect(screen.getByText("New day notes go at the top level of your personal space.")).toBeTruthy();
    // The setting is the account's, not this device's.
    expect(screen.queryByText(/this device/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Choose a note…" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search notes…" }), "journal");
    // Only notes of the personal space are offered, and never a day note.
    expect(screen.queryByRole("button", { name: "Shared journal" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Journal" }));
    expect(dayNoteParentSetting.get()).toBe("Journal");
    expect(screen.getByText("New day notes go under “Journal”.")).toBeTruthy();
    // Saved to the account on the server.
    await waitFor(() => expect(sendWrite).toHaveBeenCalledWith("PUT", "/api/me/prefs/dayNoteParent", expect.objectContaining({ value: "Journal" })));

    await dayNotes.openToday();
    expect(nodePosts()[0]).toMatchObject({ id: dayNoteId(SPACE, today()), parent_id: "Journal" });

    await userEvent.click(screen.getByRole("button", { name: "Use the top level" }));
    expect(dayNoteParentSetting.get()).toBeNull();
    await waitFor(() => expect(sendWrite).toHaveBeenLastCalledWith("PUT", "/api/me/prefs/dayNoteParent", expect.objectContaining({ value: null })));
  });

  it("shows the choice again when Settings is reopened, and keeps it while the note has not loaded", async () => {
    setData((s) => ({ ...s, nodes: [] }));
    dayNoteParentSetting.set("Journal");
    const first = render(<DayNoteParentSetting ctx={ctx} />);
    // Not loaded yet: neither "top level" nor "gone", and the choice stays.
    expect(screen.getByText("New day notes go under the note you chose.")).toBeTruthy();
    expect(screen.queryByText(/is gone/)).toBeNull();
    expect(dayNoteParentSetting.get()).toBe("Journal");
    first.unmount();
    // Loaded and the note is there: named.
    setData((s) => ({ ...s, nodes: [note("Journal")] }));
    render(<DayNoteParentSetting ctx={ctx} />);
    expect(screen.getByText("New day notes go under “Journal”.")).toBeTruthy();
  });

  it("says the note is gone only after the notes have loaded", () => {
    setData((s) => ({ ...s, nodes: [note("Other")] }));
    dayNoteParentSetting.set("Journal");
    setBootstrapped(true);
    render(<DayNoteParentSetting ctx={ctx} />);
    expect(screen.getByText("The chosen note is gone or not in your personal space, so new day notes go at the top level.")).toBeTruthy();
    expect(dayNoteParentSetting.get()).toBe("Journal"); // shown, never cleared
  });
});

describe("moving existing day notes under the parent", () => {
  const ctx = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() };
  beforeEach(() => { dayNoteParentSetting.set(null); setModules(["daily"]); });

  it("is offered only with a parent set and day notes elsewhere, and moves them only on a click", async () => {
    setData((s) => ({ ...s, nodes: [note("Journal"), note("2026-10-02"), note("2026-10-01", { parent_id: "x" })] }));
    const first = render(<DayNoteParentSetting ctx={ctx} />);
    expect(screen.queryByRole("button", { name: /existing day note/ })).toBeNull(); // no parent yet
    first.unmount();

    dayNoteParentSetting.set("Journal");
    render(<DayNoteParentSetting ctx={ctx} />);
    expect(sendOrQueue).not.toHaveBeenCalled(); // never automatic
    await userEvent.click(screen.getByRole("button", { name: "Move 2 existing day notes here" }));
    const patches = sendOrQueue.mock.calls.filter(([method]) => method === "PATCH")
      .map(([, path, body]) => [path, JSON.parse(body as string)]);
    expect(patches).toEqual([
      ["/api/nodes/2026-10-01", { parent_id: "Journal", order_key: expect.any(String) }],
      ["/api/nodes/2026-10-02", { parent_id: "Journal", order_key: expect.any(String) }],
    ]);
    // Moved (optimistically): nothing is left to offer.
    expect(screen.queryByRole("button", { name: /existing day note/ })).toBeNull();
  });

  it("is not offered when every day note is already under the parent", () => {
    dayNoteParentSetting.set("Journal");
    setData((s) => ({ ...s, nodes: [note("Journal"), note("2026-10-02", { parent_id: "Journal" })] }));
    render(<DayNoteParentSetting ctx={ctx} />);
    expect(screen.queryByRole("button", { name: /existing day note/ })).toBeNull();
  });
});

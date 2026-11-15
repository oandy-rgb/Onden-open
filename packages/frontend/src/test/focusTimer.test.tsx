// @vitest-environment jsdom
// The focus timer on screen: the server's running record is the truth (a reload
// or another device picks it up), the clock is read off its start time, time
// running out asks 「做了什麼？」 without ending anything, and the answer keeps
// what was typed when the save fails.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  start: vi.fn(), end: vi.fn(), focusOfDay: vi.fn(), savePref: vi.fn(),
}));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return {
    ...real,
    focusWriter: { start: api.start, end: api.end },
    reads: {
      ...real.reads,
      workspace: { ...real.reads.workspace, focusOfDay: api.focusOfDay },
      people: { ...real.reads.people, myPref: vi.fn().mockResolvedValue({ value: null }) },
    },
    sendWrite: api.savePref,
  };
});

import { FocusHost, FocusTopMark } from "../modules";
import { beginFocus, focusMinutesPref, openFocusEnding, requestFocus, resetFocusStore, setFocusExpanded } from "../lib/focus";
import { noWorkspaceData } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { focusCyclePref } from "../modules/tasks/focus/focusCyclePref";
import { PREFS, getPrefJson, setPrefJson } from "../lib/prefs";
import { enterBreak } from "../lib/focus/focusCycleRules";
import { startRun } from "../lib/focus/focusRunSteps";

const START = "2026-10-31T09:00:00.000Z";
const minutesAfter = (minutes: number, seconds = 0) => new Date(Date.parse(START) + minutes * 60_000 + seconds * 1000);
const running = (over: Record<string, unknown> = {}) => ({ id: "f1", task_id: "t1", started_at: START, ended_at: null, note: "", ...over });

function useMedia(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && /max-width:\s*900px/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }));
}
function mount(modules?: string[]) {
  setAppState({
    data: {
      ...noWorkspaceData,
      ...(modules ? { workspace: { ...noWorkspaceData.workspace, modules } } : {}),
      nodes: [{ id: "n1", title: "週報", node_type: "content", source_type: "manual", slug: "n1", markdown: "## 本週\n寫完第二段" }] as never,
      tasks: [{ id: "t1", node_id: "n1", title: "交報告", status: "todo" }] as never,
    },
  });
  return render(<><FocusTopMark /><FocusHost onOpenNote={vi.fn()} /></>);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(minutesAfter(10));
  localStorage.clear();
  bindAccountStorage("focus-test", "");
  resetAppState(); resetFocusStore(); focusCyclePref.store.forget();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: null });
  api.savePref.mockResolvedValue(undefined);
  useMedia(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("a running focus", () => {
  it("is picked up from the server on load (another device began it) and counts from its start time", async () => {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    mount();
    const bar = await screen.findByRole("region", { name: "Focus timer" });
    expect(within(bar).getByText("交報告")).toBeInTheDocument();
    expect(within(bar).getByText("15:00 left")).toBeInTheDocument(); // 25 min by default, begun 10 min ago
    expect(bar.textContent).not.toMatch(/f1|t1|\d{4}-\d{2}-\d{2}T/); // no id, no raw time
  });

  it("shows nothing when the server has none, and nothing at all when tasks are switched off", async () => {
    mount();
    await waitFor(() => expect(api.focusOfDay).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Focus timer" })).toBeNull();
  });

  it("stays hidden when the tasks function is off, even with one running on the server", async () => {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    mount(["notes"]);
    await act(async () => { await Promise.resolve(); });
    expect(api.focusOfDay).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Focus timer" })).toBeNull();
  });

  it("counts up when there is no timer", async () => {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    focusMinutesPref.store.save(0);
    mount();
    expect(await screen.findByText("10:00 so far")).toBeInTheDocument();
  });

  it("on a desktop it is a full screen with the task's note beside the clock; Esc tucks it into the mark and keeps counting", async () => {
    useMedia(false);
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    mount();
    await waitFor(() => expect(api.focusOfDay).toHaveBeenCalled());
    act(() => setFocusExpanded(true));
    const full = await screen.findByRole("dialog", { name: "Focus timer", hidden: true });
    expect(within(full).getByText("15:00")).toBeInTheDocument();
    expect(within(full).getByRole("complementary", { name: "The note of this task", hidden: true })).toHaveTextContent("寫完第二段");
    await userEvent.click(within(full).getByRole("button", { name: /Tuck away/, hidden: true }));
    expect(await screen.findByRole("button", { name: "Back to the focus screen" })).toHaveTextContent("15:00 left");
  });
});

describe("beginning one", () => {
  it("asks the length, starts with the one chosen and remembers it as the account's choice", async () => {
    api.start.mockResolvedValue({ status: "synced", value: running({ started_at: new Date().toISOString() }) });
    mount();
    act(() => requestFocus("t1"));
    const sheet = await screen.findByRole("dialog", { name: "Start focus", hidden: true });
    expect(within(sheet).getByText("交報告")).toBeInTheDocument();
    expect(within(sheet).getByRole("radio", { name: "25 min", hidden: true })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(sheet).getByRole("radio", { name: "50 min", hidden: true }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Start focus", hidden: true }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![0]).toMatchObject({ taskId: "t1" });
    expect(api.start.mock.calls[0]![0].id).toMatch(/^[0-9a-f-]{36}$/); // minted here so a resend finds the same record
    expect(focusMinutesPref.store.get().value).toBe(50);
    expect(await screen.findByText("50:00 left")).toBeInTheDocument();
  });

  it("a length of one's own: typed, started with, and one of the choices next time", async () => {
    api.start.mockResolvedValue({ status: "synced", value: running({ started_at: new Date().toISOString() }) });
    mount();
    act(() => requestFocus("t1"));
    const sheet = await screen.findByRole("dialog", { name: "Start focus", hidden: true });
    await userEvent.click(within(sheet).getByRole("radio", { name: "Custom…", hidden: true }));
    const start = within(sheet).getByRole("button", { name: "Start focus", hidden: true });
    expect(start).toBeDisabled(); // nothing typed yet
    await userEvent.type(within(sheet).getByLabelText("How many minutes?"), "40");
    await userEvent.click(start);
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(focusMinutesPref.store.get().value).toBe(40);
    expect(await screen.findByText("40:00 left")).toBeInTheDocument();
    act(() => resetFocusStore());
    act(() => requestFocus("t1"));
    const again = await screen.findByRole("dialog", { name: "Start focus", hidden: true });
    expect(within(again).getByRole("radio", { name: "40 min", hidden: true })).toHaveAttribute("aria-checked", "true");
  });

  it("starts with the length chosen last time", async () => {
    focusMinutesPref.store.save(15);
    mount();
    act(() => requestFocus(null));
    const sheet = await screen.findByRole("dialog", { name: "Start focus", hidden: true });
    expect(within(sheet).getByText("Focus on nothing in particular")).toBeInTheDocument();
    expect(within(sheet).getByRole("radio", { name: "15 min", hidden: true })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the sheet and says why when the start is refused", async () => {
    api.start.mockRejectedValue(new Error("boom"));
    mount();
    act(() => requestFocus("t1"));
    await userEvent.click(await screen.findByRole("button", { name: "Start focus", hidden: true }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Start focus", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Focus timer" })).toBeNull();
  });

  it("with one already running, asks to end it first instead of starting a second", async () => {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    mount();
    await screen.findByRole("region", { name: "Focus timer" });
    act(() => requestFocus("t2"));
    const ask = await screen.findByRole("dialog", { name: "End the current focus first?", hidden: true });
    expect(ask).toHaveTextContent("“交報告”");
    expect(api.start).not.toHaveBeenCalled();
    await userEvent.click(within(ask).getByRole("button", { name: "End it first", hidden: true }));
    expect(await screen.findByRole("dialog", { name: "What did you get done?", hidden: true })).toBeInTheDocument();
  });
});

describe("time running out and 「做了什麼？」", () => {
  async function runningUntilTimeIsUp() {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running({ started_at: START }) });
    vi.setSystemTime(minutesAfter(26)); // 25 min length, 26 min in
    mount();
    return screen.findByRole("dialog", { name: "What did you get done?", hidden: true });
  }

  it("asks what was done at zero, lightly, and does not end the record", async () => {
    await runningUntilTimeIsUp();
    expect(api.end).not.toHaveBeenCalled();
    expect(getAppState().toasts.map((toast) => toast.message)).toContain("Time is up. Keep going or write down what you got done.");
  });

  it("offers both places, writes with the ticks, and tells the person where it landed", async () => {
    api.end.mockResolvedValue({ status: "synced", value: { ...running(), ended_at: START, written: { diary: true, task: false } } });
    const sheet = await runningUntilTimeIsUp();
    const diary = within(sheet).getByRole("checkbox", { name: "Write it in today's journal", hidden: true });
    const task = within(sheet).getByRole("checkbox", { name: "Write it under the task", hidden: true });
    expect(diary).toBeChecked(); expect(task).toBeChecked();
    await userEvent.type(within(sheet).getByRole("textbox", { name: "What did you get done?", hidden: true }), "寫完第二段");
    await userEvent.click(task);
    await userEvent.click(within(sheet).getByRole("button", { name: "Done", hidden: true }));
    await waitFor(() => expect(api.end).toHaveBeenCalledTimes(1));
    expect(api.end.mock.calls[0]![0]).toBe("f1");
    expect(api.end.mock.calls[0]![1]).toMatchObject({ note: "寫完第二段", toDiary: true, toTask: false });
    await waitFor(() => expect(getAppState().toasts.map((toast) => toast.message)).toContain("Focus ended. Your sentence is in today's journal."));
    expect(screen.queryByRole("region", { name: "Focus timer" })).toBeNull();
  });

  it("the end is when time ran out, not when the person got to the sheet", async () => {
    api.end.mockResolvedValue({ status: "synced", value: { ...running(), ended_at: START, written: { diary: false, task: false } } });
    const sheet = await runningUntilTimeIsUp();
    await userEvent.click(within(sheet).getByRole("button", { name: "Skip writing", hidden: true }));
    await waitFor(() => expect(api.end).toHaveBeenCalled());
    expect(api.end.mock.calls[0]![1].endedAt).toBe(minutesAfter(25).toISOString());
    expect(api.end.mock.calls[0]![1]).toMatchObject({ note: "", toDiary: false, toTask: false }); // a skip writes nothing
  });

  it("keeps the sentence and the ticks when the save fails, and says why", async () => {
    api.end.mockRejectedValue(new Error("boom"));
    const sheet = await runningUntilTimeIsUp();
    const box = within(sheet).getByRole("textbox", { name: "What did you get done?", hidden: true });
    await userEvent.type(box, "寫完第二段");
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "Write it in today's journal", hidden: true }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Done", hidden: true }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(box).toHaveValue("寫完第二段");
    expect(within(sheet).getByRole("checkbox", { name: "Write it in today's journal", hidden: true })).not.toBeChecked();
    expect(screen.getByRole("dialog", { name: "What did you get done?", hidden: true })).toBeInTheDocument();
  });

  it("a saved-on-this-device end says so rather than 'ended' or 'synced'", async () => {
    api.end.mockResolvedValue({ status: "queued" });
    const sheet = await runningUntilTimeIsUp();
    await userEvent.click(within(sheet).getByRole("button", { name: "Skip writing", hidden: true }));
    await waitFor(() => expect(getAppState().toasts.map((toast) => toast.message)).toContain("Saved on this device — it will sync when the server is reachable."));
  });

  it("closing the sheet keeps focusing; pressing 結束 opens it again at that moment", async () => {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    mount();
    await screen.findByRole("region", { name: "Focus timer" });
    await userEvent.click(screen.getByRole("button", { name: "End focus" }));
    const sheet = await screen.findByRole("dialog", { name: "What did you get done?", hidden: true });
    expect(sheet).toHaveTextContent("Focused 10 min");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "What did you get done?", hidden: true })).toBeNull());
    expect(screen.getByRole("region", { name: "Focus timer" })).toBeInTheDocument();
    expect(api.end).not.toHaveBeenCalled();
  });
});

describe("the store's own steps", () => {
  it("a start that the server refuses throws and leaves no running record", async () => {
    api.start.mockRejectedValue(new Error("refused"));
    await expect(beginFocus("t1", 25, false)).rejects.toThrow("refused");
    openFocusEnding();
    expect(screen.queryByRole("region", { name: "Focus timer" })).toBeNull();
  });
});

describe("a cycle: focus → break → focus", () => {
  const CYCLE = { rest: 5, longEvery: 4 };
  const roundRun = () => startRun("f1", 25, CYCLE);
  const breakRun = () => enterBreak(roundRun(), START);
  /** A reload: the server has the record running, this device has (or has not) its run in storage. */
  async function mountRun(run: ReturnType<typeof roundRun> | null, at: Date) {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    if (run) setPrefJson(PREFS.focusRun, run);
    vi.setSystemTime(at);
    mount();
    await screen.findByRole("region", { name: "Focus timer" });
  }
  const sheet = (name: string) => screen.findByRole("dialog", { name, hidden: true });

  it("a round that runs says 「Round N」 and the break that follows", async () => {
    await mountRun(roundRun(), minutesAfter(10));
    const bar = screen.getByRole("region", { name: "Focus timer" });
    expect(bar).toHaveTextContent("交報告 · Round 1");
    act(() => setFocusExpanded(true));
    expect(await sheet("Focus timer")).toHaveTextContent("25 min, then a break of 5 min");
  });

  it("time up starts the break by itself, asks nothing and writes nothing", async () => {
    await mountRun(roundRun(), minutesAfter(26));
    await waitFor(() => expect(screen.getByRole("region", { name: "Focus timer" })).toHaveTextContent("Take a break"));
    expect(screen.getByRole("region", { name: "Focus timer" })).toHaveTextContent("4:00 left"); // read off the instant time was up
    expect(screen.queryByRole("dialog", { name: "What did you get done?", hidden: true })).toBeNull();
    expect(api.end).not.toHaveBeenCalled();
    expect(getAppState().toasts.map((toast) => toast.message)).toContain("Time is up. Break for 5 min.");
  });

  it("the break shows what it is, that it is not counted, and both ways on", async () => {
    await mountRun(breakRun(), minutesAfter(27));
    act(() => setFocusExpanded(true));
    const full = await sheet("Focus timer");
    expect(full).toHaveTextContent("Take a break");
    expect(full).toHaveTextContent("Round 1 is done");
    expect(full).toHaveTextContent("3:00");
    expect(full).toHaveTextContent("Breaks do not count as focus");
    expect(within(full).getByRole("button", { name: "That's it for today", hidden: true })).toBeInTheDocument();
    expect(within(full).getByRole("button", { name: "Skip the break", hidden: true })).toBeInTheDocument();
    expect(full.textContent).not.toMatch(/f1|t1|\d{4}-\d{2}-\d{2}T/);
  });

  it("on a desktop the little mark shows the break and what is left of it, not the round's clock", async () => {
    useMedia(false);
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    setPrefJson(PREFS.focusRun, breakRun());
    vi.setSystemTime(minutesAfter(27));
    mount();
    const mark = await screen.findByRole("button", { name: "Back to the focus screen" });
    await waitFor(() => expect(mark).toHaveTextContent("Take a break · 3:00 left"));
  });

  it("the fourth round is followed by the long break", async () => {
    await mountRun({ ...breakRun(), round: 4 }, minutesAfter(26));
    act(() => setFocusExpanded(true));
    const full = await sheet("Focus timer");
    expect(full).toHaveTextContent("Long break");
    expect(full).toHaveTextContent("14:00");
  });

  it("「Skip the break」 ends the pending record where its time was up, with no sentence, then begins the next round on the same task", async () => {
    api.end.mockResolvedValue({ status: "synced", value: { ...running(), ended_at: minutesAfter(25).toISOString(), written: { diary: false, task: false } } });
    api.start.mockImplementation(async (input: { id: string; taskId: string | null }) => ({ status: "synced", value: running({ id: input.id, task_id: input.taskId, started_at: new Date().toISOString() }) }));
    await mountRun(breakRun(), minutesAfter(27));
    act(() => setFocusExpanded(true));
    await userEvent.click(within(await sheet("Focus timer")).getByRole("button", { name: "Skip the break", hidden: true }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.end).toHaveBeenCalledTimes(1);
    expect(api.end.mock.calls[0]![0]).toBe("f1");
    expect(api.end.mock.calls[0]![1]).toMatchObject({ endedAt: minutesAfter(25).toISOString(), note: "", toDiary: false, toTask: false, fixedEnd: true });
    expect(api.start.mock.calls[0]![0]).toMatchObject({ taskId: "t1" });
    expect(api.start.mock.calls[0]![0].id).not.toBe("f1");
    expect(await screen.findByText("交報告 · Round 2")).toBeInTheDocument();
  });

  it("a failed end write does not begin the next round, and the break stays", async () => {
    api.end.mockRejectedValue(new Error("boom"));
    await mountRun(breakRun(), minutesAfter(27));
    act(() => setFocusExpanded(true));
    await userEvent.click(within(await sheet("Focus timer")).getByRole("button", { name: "Skip the break", hidden: true }));
    await waitFor(() => expect(api.end).toHaveBeenCalledTimes(1));
    expect(api.start).not.toHaveBeenCalled();
    expect(await screen.findByRole("region", { name: "Focus timer" })).toHaveTextContent("Take a break");
  });

  it("when the break is over it asks, and nothing starts until the person answers; a failed begin keeps the question with the reason", async () => {
    api.end.mockResolvedValue({ status: "synced", value: { ...running(), ended_at: minutesAfter(25).toISOString(), written: { diary: false, task: false } } });
    api.start.mockRejectedValue(new Error("boom"));
    await mountRun(breakRun(), minutesAfter(32));
    const ask = await sheet("Break is over");
    expect(ask).toHaveTextContent("You have done 1 round, 25 min focused in all. The next round will not start by itself.");
    expect(api.start).not.toHaveBeenCalled();
    expect(getAppState().toasts.map((toast) => toast.message)).toContain("Break is over. Start round 2, or call it a day.");
    await userEvent.click(within(ask).getByRole("button", { name: "Start round 2", hidden: true }));
    expect(await within(ask).findByRole("alert", { hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Break is over", hidden: true })).toBeInTheDocument();
    // The pending record is ended; trying again does not end it a second time.
    api.start.mockResolvedValue({ status: "synced", value: running({ id: "f2", started_at: new Date().toISOString() }) });
    await userEvent.click(within(ask).getByRole("button", { name: "Start round 2", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Break is over", hidden: true })).toBeNull());
    expect(api.end).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]![0].id).toBe(api.start.mock.calls[0]![0].id); // a resend of the same record
  });

  it("「That's it for today」 asks 「做了什麼？」 once, for the whole run, and the sentence goes on the pending record at its fixed end", async () => {
    api.end.mockResolvedValue({ status: "synced", value: { ...running(), ended_at: minutesAfter(25).toISOString(), written: { diary: true, task: true } } });
    await mountRun({ ...breakRun(), round: 3, finishedMinutes: [25, 25] }, minutesAfter(27));
    act(() => setFocusExpanded(true));
    await userEvent.click(within(await sheet("Focus timer")).getByRole("button", { name: "That's it for today", hidden: true }));
    const ask = await sheet("What did you get done?");
    expect(ask).toHaveTextContent("交報告 · 3 rounds, 75 min focused in all");
    await userEvent.type(within(ask).getByRole("textbox", { name: "What did you get done?", hidden: true }), "寫完第二段");
    await userEvent.click(within(ask).getByRole("button", { name: "Done", hidden: true }));
    await waitFor(() => expect(api.end).toHaveBeenCalledTimes(1));
    expect(api.end.mock.calls[0]![1]).toMatchObject({ endedAt: minutesAfter(25).toISOString(), note: "寫完第二段", toDiary: true, toTask: true, fixedEnd: true });
    expect(api.start).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Focus timer" })).toBeNull());
    expect(getPrefJson(PREFS.focusRun)).toBeNull(); // the run is over
  });

  it("「End focus」 during a round is today's 「做了什麼？」 at that moment, and the run is over once answered", async () => {
    api.end.mockResolvedValue({ status: "synced", value: { ...running(), ended_at: START, written: { diary: false, task: false } } });
    await mountRun(roundRun(), minutesAfter(10));
    await userEvent.click(screen.getByRole("button", { name: "End focus" }));
    const ask = await sheet("What did you get done?");
    expect(ask).toHaveTextContent("1 round, 10 min focused in all");
    await userEvent.click(within(ask).getByRole("button", { name: "Skip writing", hidden: true }));
    await waitFor(() => expect(api.end).toHaveBeenCalledTimes(1));
    expect(api.end.mock.calls[0]![1].fixedEnd).toBeUndefined(); // the server stamps "now"
    expect(getPrefJson(PREFS.focusRun)).toBeNull();
  });

  it("a reload during a break comes back to the break; without the run saved here it is today's time-up prompt with the same end", async () => {
    await mountRun(breakRun(), minutesAfter(27));
    expect(screen.getByRole("region", { name: "Focus timer" })).toHaveTextContent("Take a break");
    expect(screen.queryByRole("dialog", { name: "What did you get done?", hidden: true })).toBeNull();
    expect(api.end).not.toHaveBeenCalled();
  });

  it("another device (no run saved here) sees a normal focus whose time is up", async () => {
    api.focusOfDay.mockResolvedValue({ day: "2026-10-31", sessions: [], running: running() });
    vi.setSystemTime(minutesAfter(27));
    mount();
    const ask = await sheet("What did you get done?");
    expect(ask).toHaveTextContent("Focused 25 min");
    await userEvent.click(within(ask).getByRole("button", { name: "Skip writing", hidden: true }));
    await waitFor(() => expect(api.end).toHaveBeenCalled());
    expect(api.end.mock.calls[0]![1].endedAt).toBe(minutesAfter(25).toISOString());
  });

  it("a run saved for another record is dropped", async () => {
    await mountRun({ ...roundRun(), recordId: "other" }, minutesAfter(10));
    expect(screen.getByRole("region", { name: "Focus timer" })).not.toHaveTextContent("Round");
    expect(getPrefJson(PREFS.focusRun)).toBeNull();
  });

  it("a start asked for while a break is up is the 「End the current focus first?」 path, ending at the fixed instant", async () => {
    await mountRun(breakRun(), minutesAfter(27));
    act(() => requestFocus("t2"));
    const ask = await sheet("End the current focus first?");
    await userEvent.click(within(ask).getByRole("button", { name: "End it first", hidden: true }));
    expect(await sheet("What did you get done?")).toBeInTheDocument();
  });

  describe("the start sheet's Cycle row", () => {
    beforeEach(() => { api.start.mockImplementation(async (input: { id: string }) => ({ status: "synced", value: running({ id: input.id, started_at: new Date().toISOString() }) })); });
    async function openRow() {
      mount();
      act(() => requestFocus("t1"));
      const start = await sheet("Start focus");
      expect(within(start).getByRole("button", { name: /Cycle/, hidden: true })).toHaveTextContent("No cycle");
      await userEvent.click(within(start).getByRole("button", { name: /Cycle/, hidden: true }));
      return start;
    }

    it("saves the choice as the account's cycle and begins a run", async () => {
      const start = await openRow();
      await userEvent.click(within(start).getByRole("radio", { name: "Focus and break in turn", hidden: true }));
      await userEvent.click(within(start).getByRole("radio", { name: "10 min", hidden: true }));
      await userEvent.click(within(start).getByRole("radio", { name: "Every 3 rounds (15 min)", hidden: true }));
      expect(within(start).getByRole("button", { name: /Cycle/, hidden: true })).toHaveTextContent("Break 10 min · long break 15 min every 3 rounds");
      await userEvent.click(within(start).getByRole("button", { name: "Start focus", hidden: true }));
      await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
      expect(focusCyclePref.store.get().value).toEqual({ rest: 10, longEvery: 3 });
      expect(await screen.findByText(/Round 1/)).toBeInTheDocument();
      expect(getPrefJson(PREFS.focusRun)).toMatchObject({ round: 1, phase: "focus", minutes: 25, cycle: { rest: 10, longEvery: 3 } });
    });

    it("a break of one's own is typed in a number box between 1 and 60", async () => {
      const start = await openRow();
      await userEvent.click(within(start).getByRole("radio", { name: "Focus and break in turn", hidden: true }));
      await userEvent.click(within(start).getAllByRole("radio", { name: "Custom…", hidden: true }).at(-1)!); // the second one: the break's (the first is the focus length's)
      await userEvent.type(within(start).getByLabelText("How many minutes of break?"), "7");
      await userEvent.click(within(start).getByRole("button", { name: "Start focus", hidden: true }));
      await waitFor(() => expect(focusCyclePref.store.get().value).toEqual({ rest: 7, longEvery: 4 }));
    });

    it("choosing 「No timer」 turns the cycle off", async () => {
      focusCyclePref.store.save({ rest: 5, longEvery: 4 });
      mount();
      act(() => requestFocus("t1"));
      const start = await sheet("Start focus");
      expect(within(start).getByRole("button", { name: /Cycle/, hidden: true })).toHaveTextContent("Break 5 min");
      await userEvent.click(within(start).getByRole("radio", { name: "No timer", hidden: true }));
      expect(within(start).queryByRole("button", { name: /Cycle/, hidden: true })).toBeNull();
      await userEvent.click(within(start).getByRole("button", { name: "Start focus", hidden: true }));
      await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
      expect(focusCyclePref.store.get().value).toBeNull();
      expect(getPrefJson(PREFS.focusRun)).toBeNull();
    });
  });
});

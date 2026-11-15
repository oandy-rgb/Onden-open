// The 日記 / Journal page (modules/daily/JournalScreen): one day at a time (day/DayPage).
// The day's note drawn read-only, a tap on it opening the note, 「寫點什麼…」 on a day
// with none (dayNotes.openDay), the week row and the month (which replaces it) changing
// the day, the two kinds of dot, the chosen day kept across a note, the line to the Tasks
// page, the sections under the words, no timeline column. Listed only while the module is
// imported. The timeline's planning and 收工 are the Tasks page's: test/dayPlanner.test.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
vi.mock("../lib/spaces", async (original) => ({
  ...await original<typeof import("../lib/spaces")>(),
  personalSpaceId: () => "11111111-2222-4333-8444-555555555555",
}));
// A link in the body, as the real renderer draws one: it navigates by itself.
vi.mock("../components/MarkdownRenderer", () => ({
  default: ({ children, onNavigate }: { children: string; onNavigate?: (slug: string, id: string | null) => void }) => (
    <div data-testid="md">{children}<a href="#t" onClick={(e) => { e.preventDefault(); onNavigate?.("target", "target-note"); }}>a link</a></div>
  ),
}));
const lens = vi.fn(async (date: string): Promise<DayLens> => dayLensOf(date));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return { ...real, reads: { ...real.reads, workspace: { ...real.reads.workspace, dayLens: (date: string) => lens(date) } } };
});

import type { DayLens } from "@onden/markdown";
import { dayLensOf } from "./helpers/dayLens";
import JournalScreen from "../modules/daily/JournalScreen";
import { rememberPickedDay } from "../modules/daily/pickedDay";
import { sortChildren } from "../lib/childOrder";
import { dayChildren, dayNotesByDate, parentsWithCaptures } from "../modules/daily/journal";
import type { ContentNode, NodeTask } from "../lib/api";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetAppState, setData } from "../lib/appStore";
import { addDays, todayId } from "../lib/localDate";
import { dateLabel, monthLabel } from "../lib/timeLabels";
import { clockLabel } from "../lib/dayWindow";
import { weekDays, weekRangeLabel } from "../modules/daily/day/DayStrip";
import { dayNoteId } from "../lib/data/dayNotes";
import { moduleFilterFor } from "../modules";
import { importedFeatures } from "../hooks/useImportedFeatures";
import { getNavDestinations } from "../hooks/shellNavigation";

const SPACE = "11111111-2222-4333-8444-555555555555";
const today = todayId();
const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", space_id: SPACE, ...extra,
});
const dateLabelFor = (date: string) => dateLabel(`${date}T12:00:00Z`, "long", "UTC");
const props = { online: true, target: null, onOpenNode: vi.fn(), onOpenView: vi.fn(), onRefresh: vi.fn(), onImmersiveChange: vi.fn() };

beforeEach(() => {
  resetAppState();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  props.onOpenNode.mockReset();
  props.onOpenView.mockReset();
  lens.mockReset().mockImplementation(async (date: string) => dayLensOf(date));
  rememberPickedDay(today, today); // forget a day picked by an earlier test
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  setData((s) => ({ ...s, workspace: { ...s.workspace, modules: ["daily", "tasks"] } }));
  bindAccountStorage("journal-tasks-test", "");
});

describe("journal data", () => {
  it("a day note is found by its date; children are captures, not tasks", () => {
    const nodes = [
      note("2026-10-01"), note("2026-10-03", { space_id: "shared" }), note("2026-10-02", { hidden: true }),
      note("2026-09-30"), note("cap-b", { parent_id: "2026-10-01", sort_order: 2 }), note("cap-a", { parent_id: "2026-10-01", sort_order: 1 }),
      note("task", { parent_id: "2026-10-01", hidden: true }),
    ];
    const byDate = dayNotesByDate(nodes, SPACE);
    expect([...byDate.keys()].sort()).toEqual(["2026-09-30", "2026-10-01"]);
    expect([...parentsWithCaptures(nodes)]).toEqual(["2026-10-01"]);
    expect(dayChildren(nodes, "2026-10-01").map((n) => n.id)).toEqual(["cap-a", "cap-b"]);
  });
});

describe("journal order", () => {
  it("a day's captures sit in the sidebar's order, including ties on creation time", () => {
    const at = (id: string, created_at: string) => note(id, { parent_id: "2026-10-01", sort_order: 0, created_at });
    const nodes = [at("b", "2026-10-01T09:00:00Z"), at("z", "2026-10-01T08:00:00Z"), at("a", "2026-10-01T08:00:00Z")];
    expect(dayChildren(nodes, "2026-10-01").map((n) => n.id)).toEqual(sortChildren(nodes).map((n) => n.id));
    expect(dayChildren(nodes, "2026-10-01").map((n) => n.id)).toEqual(["a", "z", "b"]);
  });
});


const page = () => screen.getByRole("region", { name: "This day's page" });
const cell = (date: string) => document.querySelector<HTMLElement>(`[data-day="${date}"]`)!;
/** Taps a day in the week row (paging by week until it is on show) or in the open month. */
async function pickDate(date: string) {
  for (let i = 0; i < 8 && !cell(date); i++) await userEvent.click(screen.getByRole("button", { name: date < today ? "Previous week" : "Next week" }));
  await userEvent.click(cell(date));
}
const dateButton = () => within(page()).getByRole("button", { name: dateLabelFor(today) });
const dots = (date: string) => ({ written: !!cell(date).querySelector(".ui-month-dot.is-written"), planned: !!cell(date).querySelector(".ui-month-dot.is-planned") });
const posts = () => sendOrQueue.mock.calls.filter(([m, p]) => m === "POST" && p === "/api/nodes").map(([, , b]) => JSON.parse(b as string));

describe("the Journal page: one day", () => {
  it("draws today's note in full; a tap on the words opens the note, a link in it opens only its target", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    setData((s) => ({ ...s, nodes: [note(today, { markdown: long })] }));
    render(<JournalScreen {...props} />);
    // The whole body, however long, is on the page.
    expect(within(page()).getByTestId("md").textContent).toContain("line 59");
    await userEvent.click(within(page()).getByTestId("md"));
    expect(props.onOpenNode).toHaveBeenCalledTimes(1);
    expect(props.onOpenNode).toHaveBeenLastCalledWith(today);
    props.onOpenNode.mockClear();
    await userEvent.click(within(page()).getByRole("link", { name: "a link" }));
    expect(props.onOpenNode).toHaveBeenCalledTimes(1);
    expect(props.onOpenNode).toHaveBeenLastCalledWith("target-note");
    // The keyboard's way in.
    await userEvent.click(within(page()).getByRole("button", { name: `Open ${today}` }));
    expect(props.onOpenNode).toHaveBeenLastCalledWith(today);
  });

  it("a day with no note says 「寫點什麼…」; it starts the note through openDay, once", async () => {
    render(<JournalScreen {...props} />);
    expect(screen.queryByTestId("md")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Write something…" }));
    expect(posts()).toEqual([expect.objectContaining({ id: dayNoteId(SPACE, today), title: today })]);
    await waitFor(() => expect(props.onOpenNode).toHaveBeenCalledWith(dayNoteId(SPACE, today)));
  });

  it("a blank note is the same blank page, opening that note", async () => {
    setData((s) => ({ ...s, nodes: [note(today)] }));
    render(<JournalScreen {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Write something…" }));
    expect(props.onOpenNode).toHaveBeenCalledWith(today);
    expect(posts()).toEqual([]);
  });

  it("the date is a button with a small 「今天」 beside it; on another day that becomes 「回到今天」; there are no day arrows", async () => {
    const yesterday = addDays(today, -1);
    setData((s) => ({ ...s, nodes: [note(today, { markdown: "now" }), note(yesterday, { markdown: "before" })] }));
    render(<JournalScreen {...props} />);
    expect(within(page()).getByText("Today")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to today" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next day" })).toBeNull();
    await pickDate(yesterday);
    expect(within(page()).getByText("before")).toBeTruthy();
    expect(within(page()).queryByText("Today")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to today" }));
    expect(within(page()).getByText("now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to today" })).toBeNull();
    expect(within(page()).getByText("Today")).toBeTruthy();
  });

  it("the week row (Monday first, 一 二 三…) has one pair of arrows that page by week without choosing a day", async () => {
    render(<JournalScreen {...props} />);
    const week = screen.getByRole("grid", { name: "This week" });
    expect(within(week).getAllByRole("gridcell")).toHaveLength(7);
    expect(within(week).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(new Date(`${within(week).getAllByRole("gridcell")[0]!.getAttribute("data-day")}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(screen.getByText(weekRangeLabel(today))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous month" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByText(weekRangeLabel(addDays(today, 7)))).toBeTruthy();
    expect(within(screen.getByRole("grid", { name: "This week" })).getAllByRole("gridcell").map((c) => c.getAttribute("data-day"))).toEqual(weekDays(addDays(today, 7)));
    expect(page().getAttribute("data-date")).toBe(today);
    await userEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByText(weekRangeLabel(addDays(today, -7)))).toBeTruthy();
    // Choosing a day brings the week of that day back.
    await pickDate(addDays(today, -7));
    expect(page().getAttribute("data-date")).toBe(addDays(today, -7));
    expect(screen.getByText(weekRangeLabel(addDays(today, -7)))).toBeTruthy();
  });

  it("the month REPLACES the week row: the same arrows step months, the range reads 「2026年11月」, picking a day closes it", async () => {
    const other = `${today.slice(0, 7)}-${today.slice(8) === "10" ? "11" : "10"}`;
    setData((s) => ({ ...s, nodes: [note(today), note(other, { markdown: "other words" })] }));
    render(<JournalScreen {...props} />);
    await userEvent.click(dateButton());
    expect(screen.queryByRole("grid", { name: "This week" })).toBeNull();
    // One set of days and one pair of arrows, now meaning months.
    const [year, month] = today.split("-").map(Number) as [number, number];
    expect(screen.getAllByRole("grid")).toHaveLength(1);
    expect(screen.getByRole("grid", { name: monthLabel(year, month - 1) })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^(Previous|Next) / })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /week$/ })).toBeNull();
    expect(screen.getByText(monthLabel(year, month - 1), { selector: ".day-strip-range" })).toBeTruthy();
    expect(screen.getAllByRole("gridcell").length).toBeGreaterThanOrEqual(28);
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText(monthLabel(month === 12 ? year + 1 : year, month % 12), { selector: ".day-strip-range" })).toBeTruthy();
    expect(page().getAttribute("data-date")).toBe(today);
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(cell(other));
    expect(screen.getByRole("grid", { name: "This week" })).toBeTruthy();
    expect(screen.getAllByRole("grid")).toHaveLength(1);
    expect(within(page()).getByText("other words")).toBeTruthy();
    expect(page().getAttribute("data-date")).toBe(other);
    // The date button opens and closes it.
    await userEvent.click(within(page()).getByRole("button", { name: dateLabelFor(other) }));
    expect(screen.queryByRole("grid", { name: "This week" })).toBeNull();
    await userEvent.click(within(page()).getByRole("button", { name: dateLabelFor(other) }));
    expect(screen.getByRole("grid", { name: "This week" })).toBeTruthy();
  });

  it("the picked day is the same filled circle in the week row and in the month", async () => {
    render(<JournalScreen {...props} />);
    const picked = () => document.querySelectorAll(".ui-month-day.is-picked");
    expect(picked()).toHaveLength(1);
    expect(picked()[0]!.getAttribute("data-day")).toBe(today);
    expect(picked()[0]!.className).toContain("ui-month-day");
    const inWeek = picked()[0]!.className;
    await userEvent.click(dateButton());
    expect(picked()).toHaveLength(1);
    expect(picked()[0]!.className).toBe(inWeek);
    expect(picked()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("two kinds of dot: solid = a journal entry, hollow = tasks scheduled; the month says which is which", async () => {
    const [monday, tuesday, wednesday] = weekDays(today) as [string, string, string];
    setData((s) => ({
      ...s,
      nodes: [note(monday, { markdown: "words" }), note(tuesday, { markdown: "both" })],
      tasks: [{ id: "t1", node_id: null, title: "t1", status: "todo", when_date: tuesday, due_date: tuesday }, { id: "t2", node_id: null, title: "t2", status: "todo", when_date: wednesday, due_date: wednesday }],
    }));
    render(<JournalScreen {...props} />);
    expect(dots(monday)).toEqual({ written: true, planned: false });
    expect(dots(tuesday)).toEqual({ written: true, planned: true });
    expect(dots(wednesday)).toEqual({ written: false, planned: true });
    expect(screen.queryByText("Has a journal entry")).toBeNull();
    await userEvent.click(dateButton());
    expect(dots(tuesday)).toEqual({ written: true, planned: true });
    expect(dots(wednesday)).toEqual({ written: false, planned: true });
    expect(screen.getByText("Has a journal entry")).toBeTruthy();
    expect(screen.getByText("Has tasks scheduled")).toBeTruthy();
  });

  it("coming back from a note lands on the same day, not on today", async () => {
    const past = addDays(today, -3);
    setData((s) => ({ ...s, nodes: [note(today), note(past, { markdown: "three days ago" })] }));
    const first = render(<JournalScreen {...props} />);
    await pickDate(past);
    await userEvent.click(within(page()).getByTestId("md"));
    expect(props.onOpenNode).toHaveBeenCalledWith(past);
    first.unmount(); // the page is left for the note…
    render(<JournalScreen {...props} />); // …and comes back
    expect(page().getAttribute("data-date")).toBe(past);
    expect(within(page()).getByText("three days ago")).toBeTruthy();
  });

  it("has no timeline column and no fold button, on a desktop or a phone: one centred column", () => {
    setData((s) => ({ ...s, nodes: [note(today, { markdown: "words" })] }));
    for (const phone of [false, true]) {
      if (phone) setPhoneLayout(true);
      const { container, unmount } = render(<JournalScreen {...props} />);
      expect(container.querySelector(".day-pane")).toBeNull();
      expect(container.querySelector(".journal-layout")).toBeNull();
      expect(screen.queryByRole("region", { name: "Day timeline" })).toBeNull();
      expect(screen.queryByRole("button", { name: /the timeline/ })).toBeNull();
      expect(within(page()).getByText("words")).toBeTruthy();
      unmount();
    }
    clearPhoneLayout();
  });

  it("has no 「Journal」 title row on a desktop or a phone; the big date is the page's heading and sits in the first row", () => {
    for (const phone of [false, true]) {
      if (phone) setPhoneLayout(true);
      const { container, unmount } = render(<JournalScreen {...props} />);
      expect(screen.queryByRole("heading", { name: "Journal" })).toBeNull();
      expect(container.querySelector(".journal-head")).toBeNull();
      expect(container.querySelector(".journal-screen > :first-child")!.matches(".day-page")).toBe(true);
      expect(container.querySelector(".day-page > :first-child h2.day-page-title")).not.toBeNull();
      unmount();
    }
    clearPhoneLayout();
  });
});

describe("the Journal page: what is under the words", () => {
  const taskRow = (id: string, when: string | null, extra: Partial<NodeTask> & { time?: string } = {}): NodeTask => ({ id, node_id: null, title: id, status: "todo", when_date: when, due_date: when, ...extra });
  const section = (name: string) => screen.queryByRole("region", { name });

  it("shows the empty line when there is nothing to show", () => {
    setData((s) => ({ ...s, nodes: [note(today)] }));
    render(<JournalScreen {...props} />);
    expect(screen.getByText("No tasks or records on this day, and no note mentions it yet.")).toBeTruthy();
    expect(section("Happened this day")).toBeNull();
    expect(section("Mentions this day")).toBeNull();
  });

  it("the journal does not list to-dos: no 「從別處排到這天」, no 「接下來」 line, no task rows", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${today}T00:05:00`) });
    setData((s) => ({
      ...s,
      nodes: [note(today), note("host", { title: "Plan" })],
      tasks: [taskRow("walk", today, { node_id: "host", time: "23:30" }), taskRow("early", today, { time: "22:15" })],
    }));
    render(<JournalScreen {...props} />);
    expect(section("Planned from elsewhere")).toBeNull();
    expect(screen.queryByText("walk")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Next \d/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Timeline/ })).toBeNull();
    vi.useRealTimers();
  });

  it("today: one whole row 「還有 N 件要做　去任務 ›」 counting what is not done yet, to the Tasks page; none left, no link", async () => {
    setData((s) => ({ ...s, nodes: [note(today)], tasks: [taskRow("a", today), taskRow("b", today, { time: "09:00" }), taskRow("c", today, { status: "done" }), taskRow("later", addDays(today, 1))] }));
    const { unmount } = render(<JournalScreen {...props} />);
    const row = screen.getByRole("button", { name: /^2 things left to do\s*Go to Tasks ›$/ });
    // One whole row: the words on the left and the way to Tasks on the right are inside the same button.
    expect(row.classList.contains("day-todo-row")).toBe(true);
    expect(row.querySelector(".day-todo-text")?.textContent).toBe("2 things left to do");
    expect(row.querySelector(".day-todo-go")?.textContent).toBe("Go to Tasks ›");
    await userEvent.click(row.querySelector(".day-todo-go")!);
    expect(props.onOpenView).toHaveBeenCalledWith("tasks");
    unmount();
    setData((s) => ({ ...s, tasks: [taskRow("one", today), taskRow("c", today, { status: "done" })] }));
    const second = render(<JournalScreen {...props} />);
    expect(screen.getByRole("button", { name: /^1 thing left to do\s*Go to Tasks ›$/ })).toBeTruthy();
    second.unmount();
    setData((s) => ({ ...s, tasks: [taskRow("c", today, { status: "done" })] }));
    render(<JournalScreen {...props} />);
    expect(screen.queryByRole("button", { name: /Go to Tasks/ })).toBeNull();
  });

  it("a later day says 「排了 N 件」; a past day says nothing about tasks", async () => {
    const tomorrow = addDays(today, 1);
    const yesterday = addDays(today, -1);
    setData((s) => ({ ...s, nodes: [note(today)], tasks: [taskRow("x", tomorrow), taskRow("y", tomorrow, { time: "10:00" }), taskRow("old", yesterday)] }));
    render(<JournalScreen {...props} />);
    await pickDate(tomorrow);
    await userEvent.click(screen.getByRole("button", { name: /^2 things scheduled\s*Go to Tasks ›$/ }));
    expect(props.onOpenView).toHaveBeenCalledWith("tasks");
    await pickDate(yesterday);
    expect(screen.queryByRole("button", { name: /Go to Tasks/ })).toBeNull();
    expect(screen.queryByText("old")).toBeNull();
  });

  it("with the tasks module off there is no link to the Tasks page and no finished rows", () => {
    setData((s) => ({ ...s, workspace: { ...s.workspace, modules: ["daily"] }, nodes: [note(today)],
      tasks: [taskRow("walk", today), taskRow("done", today, { status: "done", done_at: new Date(`${today}T09:00:00`).toISOString() })] }));
    render(<JournalScreen {...props} />);
    expect(screen.queryByRole("button", { name: /Go to Tasks/ })).toBeNull();
    expect(section("Happened this day")).toBeNull();
  });

  it("finished tasks are 「這天發生的」: one 「完成了 …」 row each in finish order with the time, on the day they were finished, opening as the task opens", async () => {
    const yesterday = addDays(today, -1);
    const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
    setData((s) => ({
      ...s,
      nodes: [note(today, { markdown: "- [x] in the words" }), note("host", { title: "Plan" })],
      tasks: [
        taskRow("late", today, { status: "done", done_at: at(today, "18:30"), node_id: "host" }),
        taskRow("early", today, { status: "done", done_at: at(today, "08:05") }),
        taskRow("untimed", today, { status: "done" }),
        taskRow("in-words", today, { status: "done", done_at: at(today, "12:00"), node_id: today }),
        taskRow("yesterdays", yesterday, { status: "done", done_at: at(yesterday, "21:00") }),
        taskRow("open", today),
      ],
    }));
    render(<JournalScreen {...props} />);
    const box = section("Happened this day")!;
    const rows = within(box).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual([`Finished early${clockLabel(at(today, "08:05"))}`, `Finished late${clockLabel(at(today, "18:30"))}`, "Finished untimed"]);
    expect(within(box).queryByText(/in-words/)).toBeNull();
    expect(within(box).queryByText(/yesterdays/)).toBeNull();
    expect(screen.queryByText("No tasks or records on this day, and no note mentions it yet.")).toBeNull();
    await userEvent.click(within(box).getByRole("button", { name: /Finished late/ }));
    expect(props.onOpenNode).toHaveBeenLastCalledWith("host");
    await userEvent.click(within(box).getByRole("button", { name: /Finished early/ }));
    expect(props.onOpenNode).toHaveBeenLastCalledWith("early");
    // A past day still shows what was done on it, and no to-do line.
    await pickDate(yesterday);
    expect(within(section("Happened this day")!).getByText("Finished yesterdays")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Go to Tasks/ })).toBeNull();
  });

  it("「這天發生的」: the day's quick captures, and the notes created or saved that day, five first, the rest on request; never the day note", async () => {
    const made = Array.from({ length: 7 }, (_, i) => ({ id: `made-${i}`, title: `Made ${i}`, at: `${today}T08:0${i}:00Z` }));
    lens.mockResolvedValue(dayLensOf(today, {
      created: { items: [...made.slice(0, 4), { id: today, title: today, at: `${today}T01:00:00Z` }, { id: "cap", title: "A capture", at: `${today}T02:00:00Z` }], total: 6 },
      edited: { items: [...made.slice(4), made[0]!], total: 4 },
    }));
    setData((s) => ({ ...s, nodes: [note(today, { markdown: "body" }), note("cap", { title: "A capture", parent_id: today })] }));
    render(<JournalScreen {...props} />);
    const box = await screen.findByRole("region", { name: "Happened this day" });
    await waitFor(() => expect(within(box).getByText("Made 0")).toBeTruthy());
    // The capture once (it is a child, not a lens row too), the day note not at all, Made 0 once.
    expect(within(box).getAllByText("A capture")).toHaveLength(1);
    expect(within(box).queryByText(today)).toBeNull();
    expect(within(box).getAllByText("Made 0")).toHaveLength(1);
    expect(within(box).getAllByRole("listitem")).toHaveLength(1 + 5);
    await userEvent.click(within(box).getByRole("button", { name: "2 more notes" }));
    expect(within(box).getAllByRole("listitem")).toHaveLength(1 + 7);
    await userEvent.click(within(box).getByText("Made 6"));
    expect(props.onOpenNode).toHaveBeenLastCalledWith("made-6");
  });

  it("the lens failing (offline) leaves the captures and the rest of the page", () => {
    lens.mockRejectedValue(new Error("offline"));
    setData((s) => ({ ...s, nodes: [note(today, { markdown: "body" }), note("cap", { title: "A capture", parent_id: today })] }));
    render(<JournalScreen {...props} />);
    expect(within(section("Happened this day")!).getByText("A capture")).toBeTruthy();
    expect(within(page()).getByText("body")).toBeTruthy();
  });

  it("「提到這天的」: notes linking to the day note, with the sentence around the link", async () => {
    setData((s) => ({
      ...s,
      nodes: [note(today, { title: today }), note("src", { title: "Meeting notes", markdown: `We agreed on it, see [[${today}]] for what happened.` })],
      edges: [{ id: "e1", source_node_id: "src", target_node_id: today, edge_type: "knowledge_link", status: "active" } as never],
    }));
    render(<JournalScreen {...props} />);
    const box = section("Mentions this day")!;
    expect(within(box).getByText("Meeting notes")).toBeTruthy();
    expect(box.textContent).toContain("for what happened");
    await userEvent.click(within(box).getByRole("button", { name: /^Meeting notes/ }));
    expect(props.onOpenNode).toHaveBeenLastCalledWith("src");
  });

  it("「去年今天」 is a one-line card at the top (under the week row, above the words), only when last year's note has something", async () => {
    const lastYear = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
    setData((s) => ({ ...s, nodes: [note(today, { markdown: "today words" }), note(lastYear, { markdown: "First **thought** here." })] }));
    const { unmount } = render(<JournalScreen {...props} />);
    const card = screen.getByRole("complementary", { name: "This day last year" });
    expect(card.textContent).toContain("First thought here.");
    const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByRole("grid", { name: "This week" }), card)).toBe(true);
    expect(before(card, screen.getByTestId("md"))).toBe(true);
    await userEvent.click(within(card).getByRole("button"));
    expect(props.onOpenNode).toHaveBeenLastCalledWith(lastYear);
    unmount();
    setData((s) => ({ ...s, nodes: [note(today, { markdown: "today words" }), note(lastYear, { markdown: "  " })] }));
    render(<JournalScreen {...props} />);
    expect(screen.queryByRole("complementary", { name: "This day last year" })).toBeNull();
  });

  it("is a navigation destination only while the module is imported; the day notes stay either way", () => {
    const actions = { setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };
    const entries = (modules: string[], mode = "notes") =>
      getNavDestinations({ mode }, actions, importedFeatures(moduleFilterFor(modules), [])).modules;
    const journal = entries(["daily"]).find((d) => d.id === "daily");
    expect(journal).toMatchObject({ label: "Daily notes", current: false, indicators: [] });
    journal!.open();
    expect(actions.onOpenFeature).toHaveBeenCalledWith("daily");
    expect(entries(["daily"], "daily").find((d) => d.id === "daily")?.current).toBe(true);
    expect(entries(["canvas"]).map((d) => d.id)).not.toContain("daily");
    const nodes = [note("2026-10-01"), note("2026-09-30")];
    expect([...dayNotesByDate(nodes, SPACE).keys()]).toEqual(["2026-10-01", "2026-09-30"]);
  });
});

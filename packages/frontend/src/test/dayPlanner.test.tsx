// The Tasks page's 今天 plan (modules/daily/day/DayPane, mounted by modules/tasks/TasksMode):
// 可以排進今天的 (late and due-soon tasks, with their own buttons), 還沒排時間, the timeline with its
// 「現在」 line, and 3 天 / 週 (wide screens only) with dragging a not-yet-planned task onto a day. The Journal page's one-day view is journalScreen.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  upsertNode: async () => {}, removeNode: async () => {}, upsertAttribute: async () => {}, upsertTask: async () => {}, removeTask: async () => {},
}));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  const { dayLensOf } = await import("./helpers/dayLens");
  return { ...real, reads: { ...real.reads, workspace: { ...real.reads.workspace, dayLens: async (date: string) => dayLensOf(date) } } };
});

import "../modules";
import TasksMode from "../modules/tasks/TasksMode";
import type { ContentNode, NodeTask } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { addDays, todayId } from "../lib/localDate";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

const today = todayId();
const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", ...extra,
});
const taskRow = (id: string, when: string | null, extra: Partial<NodeTask> & { time?: string } = {}): NodeTask => ({ id, node_id: `n-${id}`, title: id, status: "todo", when_date: when, due_date: when, ...extra });
const patches = () => sendOrQueue.mock.calls.filter(([m]) => m === "PATCH").map(([, p, b]) => [p, JSON.parse(b as string)]);
const seed = (tasks: NodeTask[], modules = ["daily", "tasks"]) =>
  setData((s) => ({ ...s, workspace: { ...s.workspace, modules }, nodes: tasks.map((t) => note(`n-${t.id}`, { title: `note of ${t.title}` })), tasks }));
const renderTasks = () => render(<TasksMode online onSelectNode={vi.fn()} onRefresh={() => {}} onError={vi.fn()} reminderPermission="unsupported" onEnableReminders={() => {}} />);
// The plan is a lazy chunk: wait for its header.
const planner = () => screen.findByRole("region", { name: "Day timeline" });

beforeEach(() => {
  resetAppState();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  bindAccountStorage("day-planner-test", "");
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => clearPhoneLayout());

describe("the Tasks page's 今天", () => {
  it("has the timeline with its 「現在」 line and no ⋯ menu (收工 and 規劃今天 are gone); a task with a time is on the timeline once, with one timer button", async () => {
    seed([taskRow("walk", today), taskRow("call", today, { time: "23:00" })]);
    renderTasks();
    const pane = await planner();
    expect(within(pane).getByTestId("day-timeline")).toBeTruthy();
    expect(within(pane).getByRole("separator", { name: "Now" })).toBeTruthy();
    expect(within(pane).queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getAllByText("call")).toHaveLength(1);
    expect(within(within(pane).getByTestId("day-timeline")).getByText("call")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Start focus on call" })).toHaveLength(1);
  });

  it("is only on the 今天 tab", async () => {
    seed([taskRow("walk", today)]);
    renderTasks();
    await planner();
    await userEvent.click(screen.getByRole("tab", { name: /Coming up/ }));
    expect(screen.queryByRole("region", { name: "Day timeline" })).toBeNull();
  });

  it("has the timeline on a phone too, but only one day: no 1 天 / 3 天 / 週 switch", async () => {
    setPhoneLayout(true);
    seed([taskRow("walk", today)]);
    const { container } = renderTasks();
    const pane = await planner();
    expect(container.querySelector(".day-pane.is-phone")).not.toBeNull();
    expect(within(pane).getByTestId("day-timeline")).toBeTruthy();
    expect(within(pane).queryByRole("radiogroup", { name: "How many days" })).toBeNull();
  });

  it("a week picked on a wide screen is one day again when the screen is a phone", async () => {
    let phone = false;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() { return phone && query === "(max-width: 900px)"; },
      media: query,
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    })) as unknown as typeof window.matchMedia;
    seed([taskRow("walk", today)]);
    renderTasks();
    const pane = await planner();
    await userEvent.click(within(pane).getByRole("radio", { name: "Week" }));
    expect(screen.queryByTestId("day-timeline")).toBeNull();
    phone = true;
    act(() => listeners.forEach((fn) => fn()));
    expect(await screen.findByTestId("day-timeline")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "How many days" })).toBeNull();
  });

  describe("when today is empty", () => {
    const anytime = (id: string) => taskRow(id, null, { due_date: null });

    it("lists the first few 「隨時」 tasks under the sentence, with 排到今天, and 「看全部」 opens that tab", async () => {
      seed(["a", "b", "c", "d", "e", "f", "g"].map(anytime));
      renderTasks();
      await planner();
      expect(screen.getByText("Nothing for today.")).toBeTruthy();
      const card = screen.getByRole("region", { name: "Can do anytime · 7" });
      expect(within(card).getAllByRole("button", { name: /^Plan .* for today$/ })).toHaveLength(5);
      expect(within(card).queryByText("f")).toBeNull();
      await userEvent.click(within(card).getByRole("button", { name: "See all ›" }));
      expect(screen.getByRole("tab", { name: /Anytime/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("does not list them while today has a candidate or a task", async () => {
      seed([anytime("a"), taskRow("late", addDays(today, -2))]);
      const first = renderTasks();
      await planner();
      expect(screen.queryByRole("region", { name: /Can do anytime/ })).toBeNull();
      first.unmount();
      seed([anytime("a"), taskRow("walk", today)]);
      renderTasks();
      await planner();
      expect(screen.queryByRole("region", { name: /Can do anytime/ })).toBeNull();
    });

    it("offers adding one thing when 「隨時」 is empty too", async () => {
      seed([]);
      renderTasks();
      await planner();
      expect(screen.getByText("Nothing for today.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add one thing" })).toBeTruthy();
    });
  });

  it("is not there while the tasks module is off", () => {
    seed([], ["daily"]);
    const { container } = renderTasks();
    expect(container.querySelector(".day-pane")).toBeNull();
  });

  it("works while the daily-notes module is off", async () => {
    seed([taskRow("walk", today)], ["tasks"]);
    renderTasks();
    const pane = await planner();
    expect(within(pane).getByTestId("day-timeline")).toBeTruthy();
  });

  it("a task with no time waits in the dashed 「還沒排時間」 list, not on the timeline; it always shows, with its count", async () => {
    seed([taskRow("walk", today), taskRow("call", today, { time: "23:00" })]);
    renderTasks();
    const pane = await planner();
    const strip = within(pane).getByRole("region", { name: "Not scheduled yet" });
    expect(within(strip).getByText("walk")).toBeTruthy();
    expect(within(strip).getByRole("heading", { name: /Not scheduled yet/ }).textContent).toBe("Not scheduled yet1");
    expect(within(strip).queryByText("call")).toBeNull();
    expect(within(within(pane).getByTestId("day-timeline")).queryByText("walk")).toBeNull();
    expect(screen.getAllByText("walk")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Start focus on walk" })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /Can go on today/ })).toBeNull();
  });

  it("an overdue task that had a time has no block today, so the card has it; a near deadline is there too", async () => {
    seed([taskRow("late", addDays(today, -1), { time: "09:00" }), taskRow("soon", addDays(today, 3), { deadline: addDays(today, 1) })]);
    renderTasks();
    const card = within(await planner()).getByRole("region", { name: "Can go on today · 2" });
    expect(within(card).getByText("late")).toBeTruthy();
    expect(within(card).getByText("soon")).toBeTruthy();
    expect(within(await planner()).queryByRole("region", { name: "Not scheduled yet" })).toBeNull();
  });

  it("has no strip when nothing is waiting, and no explanation line or 「今天」 heading above the timeline", async () => {
    seed([taskRow("call", today, { time: "23:00" })]);
    renderTasks();
    await planner();
    expect(screen.queryByRole("region", { name: "Not scheduled yet" })).toBeNull();
    expect(screen.queryByText("Things to do today, plus ones with a deadline coming up")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Today" })).toBeNull();
  });

  it("names the note a task sits in only when it is not that day's own journal page", async () => {
    setData((s) => ({ ...s, workspace: { ...s.workspace, modules: ["daily", "tasks"] },
      nodes: [note("diary", { title: today }), note("plans", { title: "Weekend plans" })],
      tasks: [taskRow("in-diary", today, { node_id: "diary" }), taskRow("elsewhere", today, { node_id: "plans" })] }));
    renderTasks();
    const strip = within(await planner()).getByRole("region", { name: "Not scheduled yet" });
    expect(within(strip).getByText("From Weekend plans")).toBeTruthy();
    expect(within(strip).queryByText(/journal/)).toBeNull();
  });

  it("shows the date beside the title only for 3 天 / 週, not for 1 天", async () => {
    seed([]);
    const { container } = renderTasks();
    const pane = await planner();
    expect(container.querySelector(".day-pane-date")).toBeNull();
    await userEvent.click(within(pane).getByRole("radio", { name: "3 days" }));
    expect(container.querySelector(".day-pane-date")).not.toBeNull();
  });
});

describe("「可以排進今天的」 on the Tasks page's 今天", () => {
  const card = async (n: number) => within(await planner()).getByRole("region", { name: `Can go on today · ${n}` });

  it("late and due-soon tasks are one card with its count; late ones first, longest-waiting on top", async () => {
    seed([taskRow("walk", today), taskRow("soon", today, { deadline: addDays(today, 1) }), taskRow("a", addDays(today, -1)), taskRow("b", addDays(today, -3))]);
    renderTasks();
    const c = await card(3);
    expect(within(c).getByRole("heading", { name: "Can go on today · 3" })).toBeTruthy();
    expect(within(c).getAllByText(/^(a|b|soon|walk)$/).map((el) => el.textContent)).toEqual(["b", "a", "soon"]);
    // What is only dated today stays in the one-line list.
    expect(within(within(await planner()).getByRole("region", { name: "Not scheduled yet" })).getByText("walk")).toBeTruthy();
  });

  it("no candidates: no card; no 都留在今天 button anywhere", async () => {
    seed([taskRow("walk", today)]);
    renderTasks();
    await planner();
    expect(screen.queryByRole("region", { name: /Can go on today/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep all on today" })).toBeNull();
  });

  it("lists three; 「看全部」 opens the rest in the same card, and closes it again", async () => {
    seed([1, 2, 3, 4, 5].map((n) => taskRow(`t${n}`, addDays(today, -n))));
    renderTasks();
    const c = await card(5);
    expect(within(c).getAllByRole("listitem")).toHaveLength(3);
    expect(within(c).getByText("t5")).toBeTruthy(); // the longest-waiting first
    expect(within(c).queryByText("t1")).toBeNull();
    await userEvent.click(within(c).getByRole("button", { name: "See all ›" }));
    expect(within(c).getAllByRole("listitem")).toHaveLength(5);
    await userEvent.click(within(c).getByRole("button", { name: "Show fewer" }));
    expect(within(c).getAllByRole("listitem")).toHaveLength(3);
  });

  it("three or fewer: no 「看全部」", async () => {
    seed([taskRow("a", addDays(today, -1)), taskRow("b", addDays(today, -2)), taskRow("c", addDays(today, -3))]);
    renderTasks();
    expect(within(await card(3)).queryByRole("button", { name: "See all ›" })).toBeNull();
  });

  it("says which day a late task was left over from and where it was written", async () => {
    seed([taskRow("a", addDays(today, -1)), taskRow("b", addDays(today, -10))]);
    renderTasks();
    const c = await card(2);
    expect(within(c).getByText("Left over from yesterday")).toBeTruthy();
    expect(within(c).getByText("Left over from 10 days ago")).toBeTruthy();
    expect(within(c).getByText("From note of a")).toBeTruthy();
  });

  it("a late row has two visible buttons, 排到今天 and 某天; a due-soon row only 排到今天", async () => {
    seed([taskRow("late", addDays(today, -2)), taskRow("soon", addDays(today, 5), { deadline: addDays(today, 1) })]);
    renderTasks();
    const c = await card(2);
    expect(within(c).getByRole("button", { name: "Plan late for today" })).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Move late to Someday" })).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Plan soon for today" })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: "Move soon to Someday" })).toBeNull();
  });

  it("a due-soon task already dated today has no 排到今天 (nothing to write)", async () => {
    seed([taskRow("soon", today, { deadline: today })]);
    renderTasks();
    expect(within(await card(1)).queryByRole("button", { name: /Plan soon for today/ })).toBeNull();
  });

  it("排到今天 writes the day and clears the flags, tells it, and Undo gives the old day back", async () => {
    const day = addDays(today, -4);
    seed([taskRow("a", day), taskRow("other", addDays(today, -1))]);
    renderTasks();
    await userEvent.click(within(await card(2)).getByRole("button", { name: "Plan a for today" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()).toEqual([["/api/tasks/a", { when_date: today, evening: false, someday: false }]]);
    const toast = getAppState().toasts.find((x) => x.action?.label === "Undo")!;
    expect(toast.message).toBe("Planned “a” for today");
    sendOrQueue.mockClear();
    await act(async () => { toast.action!.onClick(); });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()).toEqual([["/api/tasks/a", { when_date: day, evening: false, someday: false }]]);
  });

  it("某天 is the task sheet's 某天: parked, no day", async () => {
    seed([taskRow("a", addDays(today, -1))]);
    renderTasks();
    await userEvent.click(within(await card(1)).getByRole("button", { name: "Move a to Someday" }));
    await waitFor(() => expect(patches()).toEqual([["/api/tasks/a", expect.objectContaining({ someday: true, when_date: null })]]));
  });

  it("「不做了」 in the task sheet cancels a task with a box and tells it with an Undo", async () => {
    seed([taskRow("a", addDays(today, -1))]);
    renderTasks();
    await userEvent.click(within(await card(1)).getByRole("button", { name: "Edit a" }));
    await userEvent.click(screen.getByRole("button", { name: /^Won't do/ }));
    await waitFor(() => expect(patches()).toEqual([["/api/tasks/a", { status: "cancelled" }]]));
    const toast = getAppState().toasts.find((x) => x.action?.label === "Undo")!;
    sendOrQueue.mockClear();
    await act(async () => { toast.action!.onClick(); });
    await waitFor(() => expect(patches()).toEqual([["/api/tasks/a", { status: "todo" }]]));
  });

  it("a row of the card still drags onto the timeline", async () => {
    seed([taskRow("a", addDays(today, -1))]);
    const { container } = renderTasks();
    await card(1);
    expect(container.querySelector(".tk-candidates .tk-row[draggable='true']")).not.toBeNull();
  });
});

describe("3 天 / 週 on the Tasks page", () => {
  const dropOn = (target: HTMLElement, id: string) =>
    fireEvent.drop(target, { dataTransfer: { getData: () => id, setData: () => {}, types: ["text/x-onden-task"] } });

  it("the days go side by side; dragging a not-yet-planned task onto a day sets that day", async () => {
    seed([taskRow("loose", null), taskRow("planned", today)]);
    const { container } = renderTasks();
    await userEvent.click(within(await planner()).getByRole("radio", { name: "Week" }));
    expect(screen.queryByTestId("day-timeline")).toBeNull();
    const shelf = screen.getByRole("complementary", { name: "Not planned yet" });
    expect(within(shelf).getByText("loose")).toBeTruthy();
    expect(within(shelf).queryByText("planned")).toBeNull();
    const target = addDays(today, 1);
    // The week may end before tomorrow (Sunday): the board then shows tomorrow's week.
    const day = container.querySelector(`.week-column[data-date="${target}"]`) ? target : today;
    dropOn(container.querySelector<HTMLElement>(`.week-column[data-date="${day}"]`)!, "loose");
    await waitFor(() => expect(patches()).toEqual([["/api/tasks/loose", expect.objectContaining({ when_date: day })]]));
  });

  it("「排到今天」 plans a task without dragging", async () => {
    seed([taskRow("loose", null)]);
    renderTasks();
    await userEvent.click(within(await planner()).getByRole("radio", { name: "3 days" }));
    await userEvent.click(screen.getByRole("button", { name: "Plan for today" }));
    await waitFor(() => expect(patches()).toEqual([["/api/tasks/loose", expect.objectContaining({ when_date: today })]]));
  });

  it("choosing a day's column goes to that day's timeline, and 「回到今天」 returns", async () => {
    seed([taskRow("tomorrow-thing", addDays(today, 3))]);
    renderTasks();
    await userEvent.click(within(await planner()).getByRole("radio", { name: "3 days" }));
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`${Number(addDays(today, 2).slice(8))}$`) }));
    expect(screen.getByTestId("day-timeline")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back to today" }));
    expect(screen.queryByRole("button", { name: "Back to today" })).toBeNull();
  });
});

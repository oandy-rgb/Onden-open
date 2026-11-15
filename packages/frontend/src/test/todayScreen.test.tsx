// The 今天 page (modules/daily/today): the three columns and what each holds, the degrade when the journal or tasks
// are off, the journal column's box (nothing is made until a line is added), folding it, 「全部的事」, the span switch.

import { beforeEach, describe, expect, it, vi } from "vitest";
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
  upsertNode: async () => {}, removeNode: async () => {}, upsertAttribute: async () => {}, upsertTask: async () => {}, removeTask: async () => {},
}));
vi.mock("../lib/spaces", async (original) => ({
  ...await original<typeof import("../lib/spaces")>(),
  personalSpaceId: () => "11111111-2222-4333-8444-555555555555",
}));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  const { dayLensOf } = await import("./helpers/dayLens");
  return { ...real, reads: { ...real.reads, workspace: { ...real.reads.workspace, dayLens: async (d: string) => dayLensOf(d), focusOfDay: async () => ({ day: "", sessions: [], running: null }) } } };
});

import "../modules";
import TodayScreen from "../modules/daily/today/TodayScreen";
import { pickedDay } from "../modules/daily/pickedDay";
import { rememberTodayPickedDay } from "../modules/daily/today/todayPickedDay";
import type { ContentNode, NodeTask } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetAppState, setData } from "../lib/appStore";
import { focusStore, requestFocus } from "../lib/focus";
import { addDays, todayId } from "../lib/localDate";

const today = todayId();
const task = (id: string, when: string | null, extra: Partial<NodeTask> = {}): NodeTask => ({ id, node_id: null, title: id, status: "todo", when_date: when, due_date: when, ...extra }) as NodeTask;

function layout({ wide = true, phone = false } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: (phone && query === "(max-width: 900px)") || (wide && query === "(min-width: 1280px)"),
    media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}
const seed = (modules: string[], tasks: NodeTask[] = [], nodes: ContentNode[] = []) =>
  setData((s) => ({ ...s, workspace: { ...s.workspace, modules }, nodes, tasks }));
const open = vi.fn();
const view = () => render(<TodayScreen online onOpenNode={open} onRefresh={() => {}} />);

beforeEach(() => {
  resetAppState();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  open.mockReset();
  localStorage.clear();
  bindAccountStorage("today-test", "");
  rememberTodayPickedDay(today, today);
  Element.prototype.scrollIntoView = vi.fn();
  layout();
});

describe("the three columns", () => {
  it("lists 還沒做完, 今天要做的 and 還沒排的 in that order, with the timeline and the journal beside them", async () => {
    seed(["daily", "tasks"], [task("late", addDays(today, -1)), task("now", today), task("someday-ish", null)]);
    view();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/\d+$/, ""));
    expect(titles.slice(0, 3)).toEqual(["Not finished yet", "To do today", "Still to plan"]);
    expect(await screen.findByRole("region", { name: "Day timeline" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Journal" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Start focus on now" }).length).toBeGreaterThan(0);
  });

  it("makes no note until a line is added in the journal box", async () => {
    seed(["daily", "tasks"]);
    view();
    const box = screen.getByRole("textbox", { name: "Write something…" });
    await userEvent.type(box, "hello");
    expect(sendOrQueue.mock.calls.filter(([m]) => m === "POST")).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Add to the journal" }));
    await waitFor(() => expect(sendOrQueue.mock.calls.some(([m]) => m === "POST")).toBe(true));
  });

  it("folds the journal and remembers it; the header brings it back", async () => {
    seed(["daily", "tasks"]);
    const first = view();
    await userEvent.click(screen.getByRole("button", { name: "Fold the journal" }));
    expect(screen.queryByRole("region", { name: "Journal" })).toBeNull();
    first.unmount();
    view();
    expect(screen.queryByRole("region", { name: "Journal" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Show the journal/ }));
    expect(screen.getByRole("region", { name: "Journal" })).toBeTruthy();
  });

  it("「全部的事」 opens over the left column and Esc closes it", async () => {
    seed(["daily", "tasks"], [task("a", today)]);
    view();
    await userEvent.click(screen.getByRole("button", { name: "All tasks ›" }));
    const panel = screen.getByRole("region", { name: "All tasks" });
    expect(within(panel).getByRole("tab", { name: /Coming up/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Day timeline" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "All tasks" })).toBeNull();
  });

  it("going to another day lists that day's things", async () => {
    seed(["daily", "tasks"], [task("tomorrow-thing", addDays(today, 1))]);
    view();
    expect(screen.queryByText("tomorrow-thing")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(screen.getAllByText("tomorrow-thing").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /To do on this day/, level: 3 })).toBeTruthy();
  });
});

describe("when a function is off", () => {
  it("with the journal off there is no journal column", () => {
    seed(["tasks"], [task("a", today)]);
    view();
    expect(screen.queryByRole("region", { name: "Journal" })).toBeNull();
    expect(screen.getByRole("heading", { name: /To do today/, level: 3 })).toBeTruthy();
  });

  it("with tasks off there is only the journal and a plain timeline", async () => {
    seed(["daily"]);
    view();
    expect(screen.getByRole("region", { name: "Journal" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /To do today/, level: 3 })).toBeNull();
    expect(await screen.findByRole("region", { name: "Day timeline" })).toBeTruthy();
  });
});

describe("the span", () => {
  it("3 天 / 週 use the week board and 月 the month; a phone has none of the switch", async () => {
    seed(["daily", "tasks"]);
    const first = view();
    await userEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(document.querySelector(".week-board")).not.toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(screen.getByRole("button", { name: "Next month" })).toBeTruthy();
    first.unmount();
    localStorage.clear();
    layout({ phone: true, wide: false });
    view();
    expect(screen.queryByRole("radiogroup", { name: "How many days" })).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Day timeline" })).toBeTruthy();
  });
});

describe("review fixes", () => {
  it("the day picked here is not the day the Journal page opens on", async () => {
    seed(["daily", "tasks"]);
    view();
    await userEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(pickedDay(today)).toBe(today);
  });

  it("on a phone with tasks off the page is the journal's column, with no tab that does nothing", () => {
    seed(["daily"]);
    layout({ phone: true, wide: false });
    view();
    expect(screen.getByRole("region", { name: "Journal" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Write something…" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Day timeline" })).toBeNull();
  });

  it("a past day has no 「加一件事…」", async () => {
    seed(["daily", "tasks"]);
    view();
    expect(screen.getByRole("button", { name: "Add something…" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.queryByRole("button", { name: "Add something…" })).toBeNull();
  });
});

describe("journal × tasks × desktop / phone", () => {
  const cases: Array<[string, string[], boolean]> = [
    ["desktop, journal and tasks", ["daily", "tasks"], false], ["desktop, journal only", ["daily"], false], ["desktop, tasks only", ["tasks"], false],
    ["phone, journal and tasks", ["daily", "tasks"], true], ["phone, journal only", ["daily"], true], ["phone, tasks only", ["tasks"], true],
  ];
  it.each(cases)("%s: what shows is what is on, and every control does something", async (_name, modules, phone) => {
    seed(modules, [task("a", today)]);
    layout({ phone, wide: !phone });
    view();
    const journalOn = modules.includes("daily");
    const tasksOn = modules.includes("tasks");
    expect(!!screen.queryByRole("region", { name: "Journal" }) || !!screen.queryByRole("button", { name: /Today's journal/ })).toBe(journalOn);
    expect(!!screen.queryAllByRole("heading", { level: 3, name: /To do today/ }).length).toBe(tasksOn);
    if (phone && tasksOn) {
      for (const name of ["Task list", "Timeline view", "Month"]) {
        await userEvent.click(screen.getByRole("radio", { name }));
        expect(screen.getByRole("radio", { name }).getAttribute("aria-checked")).toBe("true");
      }
    }
  });
});

describe("second review", () => {
  it("a press on a block of the focus lane is that block's own: it opens the task, no 「排時間」 slot", async () => {
    const { default: DayTimeline } = await import("../modules/daily/day/DayTimeline");
    const onSlot = vi.fn();
    const onOpen = vi.fn();
    const at = new Date(`${today}T09:00:00`).toISOString();
    const until = new Date(`${today}T09:30:00`).toISOString();
    const { container } = render(
      <DayTimeline date={today} nowMs={Date.now()} focusLane onOpen={onOpen} plan={{ onSlot, onDropTask: vi.fn() }}
        items={[{ at, until, kind: "focus", title: "write", ref: { type: "task", id: "w" }, past: true }]} />,
    );
    await userEvent.click(container.querySelector(".day-focus-block")!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSlot).not.toHaveBeenCalled();
  });

  it("「展開日記」 is offered only when the journal is really folded away (not with tasks off)", () => {
    localStorage.setItem("onden.todayJournalFolded", "1");
    seed(["daily"]);
    view();
    expect(screen.getByRole("region", { name: "Journal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show the journal/ })).toBeNull();
  });

  it("Esc with the task sheet open closes the sheet, not 「全部的事」", async () => {
    seed(["daily", "tasks"], [task("a", today)]);
    view();
    await userEvent.click(screen.getByRole("button", { name: "All tasks ›" }));
    const panel = screen.getByRole("region", { name: "All tasks" });
    await userEvent.click(within(panel).getByRole("button", { name: "Edit a" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "All tasks" })).toBeTruthy();
  });

  it("a focus asked from inside the page stays on the page; from elsewhere it does not", () => {
    document.body.innerHTML = '<div data-focus-stays><button id="in">in</button></div><button id="out">out</button>';
    document.getElementById("in")!.focus();
    requestFocus("t");
    expect(focusStore.get().request?.stay).toBe(true);
    document.getElementById("out")!.focus();
    requestFocus("t");
    expect(focusStore.get().request?.stay).toBe(false);
  });

  it("on a phone with tasks off the journal page has the week row and the month", async () => {
    seed(["daily"]);
    layout({ phone: true, wide: false });
    view();
    expect(screen.getByRole("grid", { name: "This week" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show the month" }));
    expect(screen.getByRole("button", { name: "Next month" })).toBeTruthy();
  });
});

// 這一天 (modules/daily/day): where the modules' DayItems come from and how the
// page shows them — tasks (timed and not), captures under the day note, the
// timeline's placement and "now" line, the top bar's 「接下來」 tag. The Tasks
// page's part of it (3 天 / 週, planning, 收工) is test/dayPlanner.test.tsx. Layout maths has its own tests
// (markdown dayItems.test.ts, lib/dayWindow.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
vi.mock("../components/MarkdownRenderer", () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return { ...real, reads: { ...real.reads, workspace: { ...real.reads.workspace, dayLens: (date: string) => lens(date) } } };
});

import type { DayItem, DayLens } from "@onden/markdown";
import { dayLensOf } from "./helpers/dayLens";
import DayPane from "../modules/daily/day/DayPane";
import JournalScreen from "../modules/daily/JournalScreen";
import { captureDayItems } from "../modules/daily/dayItems";
import { joinDayItems } from "../modules/daily/day/useDayItems";
import NextUpTag from "../components/NextUpTag";
import { taskDayItems } from "../lib/tasks";
import type { ContentNode, NodeTask } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetAppState, setData } from "../lib/appStore";
import { addDays, todayId } from "../lib/localDate";
import { clockInstant } from "../lib/dayWindow";
import { clearPhoneLayout } from "./phoneMedia";
import { rememberPickedDay } from "../modules/daily/pickedDay";

const SPACE = "11111111-2222-4333-8444-555555555555";
const lens = vi.fn(async (date: string): Promise<DayLens> => dayLensOf(date));
const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", space_id: SPACE, ...extra,
});
type TimedTask = NodeTask & { time?: string; until?: string };
const task = (id: string, when: string | null, extra: Partial<TimedTask> = {}): TimedTask => ({ id, node_id: null, title: id, status: "todo", when_date: when, due_date: when, ...extra });
const props = { online: true, target: null, onOpenNode: vi.fn(), onRefresh: vi.fn(), onImmersiveChange: vi.fn() };
const today = todayId();

beforeEach(() => {
  resetAppState();
  sendOrQueue.mockReset().mockResolvedValue(undefined);
  lens.mockReset().mockImplementation(async (date: string) => dayLensOf(date));
  props.onOpenNode.mockReset();
  setData((s) => ({ ...s, workspace: { ...s.workspace, modules: ["daily", "tasks"] } }));
  bindAccountStorage("day-timeline-test", "");
  rememberPickedDay(today, today);
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { clearPhoneLayout(); vi.useRealTimers(); });

describe("what the modules hand over for a day", () => {
  const ctx = (date: string, over: Partial<Parameters<typeof taskDayItems>[0]> = {}) => ({ date, today, nodes: [], tasks: [], tags: [], ...over });

  it("tasks of the day: untimed ones have no time, a timed one is placed, finished and cancelled are handled", () => {
    const items = taskDayItems(ctx(today, {
      nodes: [note("host", { title: "Plan" })],
      tasks: [task("a", today, { node_id: "host" }), task("b", today, { time: "15:00", until: "16:30" }), task("c", today, { status: "done" }), task("d", today, { status: "cancelled" }), task("e", addDays(today, 1))],
    }));
    expect(items.map((i) => i.ref?.id)).toEqual(["a", "b", "c"]);
    expect(items[0]).toMatchObject({ detail: "From Plan", done: false });
    expect(items[0]!.at).toBeUndefined();
    expect(items[1]).toMatchObject({ at: clockInstant(today, "15:00"), until: clockInstant(today, "16:30") });
    expect(items[2]).toMatchObject({ done: true, past: true });
  });

  it("an open task on an earlier day is past; the same task has no time without a time field", () => {
    const earlier = addDays(today, -3);
    expect(taskDayItems(ctx(earlier, { tasks: [task("a", earlier)] }))[0]).toMatchObject({ past: true, done: false });
    expect(taskDayItems(ctx(today, { tasks: [task("a", today)] }))[0]!.at).toBeUndefined();
  });

  it("captures are the day note's visible children at their creation time; hidden and deleted ones are not listed", () => {
    const date = "2026-10-01";
    const nodes = [
      note(date), note("cap", { parent_id: date, created_at: "2026-10-01T09:30:00Z", markdown: "first line\nmore" }),
      note("hid", { parent_id: date, hidden: true, created_at: "2026-10-01T09:40:00Z" }),
      note("gone", { parent_id: date, created_at: "2026-10-01T09:50:00Z", deleted_at: "2026-10-02T00:00:00Z" } as Partial<ContentNode>),
      note("other", { created_at: "2026-10-01T09:55:00Z" }),
    ];
    const items = captureDayItems({ date, today, nowMs: Date.parse("2026-10-01T12:00:00Z"), nodes, tasks: [], tags: [] });
    expect(items).toEqual([expect.objectContaining({ kind: "capture", title: "cap", detail: "first line", at: "2026-10-01T09:30:00.000Z", past: true, ref: { type: "note", id: "cap" } })]);
  });

  it("the server's items join the local ones without listing a capture twice", () => {
    const local: DayItem[] = [{ kind: "capture", title: "cap", at: "2026-10-01T09:30:00Z", ref: { type: "note", id: "cap" }, past: true }];
    const remote: DayItem[] = [
      { kind: "created", title: "cap", at: "2026-10-01T09:30:00Z", ref: { type: "note", id: "cap" }, past: true },
      { kind: "created", title: "new", at: "2026-10-01T08:00:00Z", ref: { type: "note", id: "new" }, past: true },
    ];
    expect(joinDayItems(local, remote, Date.parse("2026-10-01T12:00:00Z")).map((i) => i.title)).toEqual(["new", "cap"]);
  });
});

describe("the day timeline (the Tasks page's DayPane; the Journal page has none)", () => {
  it("edits the server sends are not on the timeline (History shows them), but a focus session is", async () => {
    const at = new Date().toISOString();
    lens.mockResolvedValue(dayLensOf(today, { items: [{ kind: "edit", title: "", count: 3, at, until: at, ref: { type: "note", id: "n1" }, past: true }] }));
    setData((s) => ({ ...s, nodes: [note(today)] }));
    render(<DayPane onOpenNode={props.onOpenNode} />);
    await screen.findByTestId("day-timeline");
    await waitFor(() => expect(lens).toHaveBeenCalledWith(today));
    expect(within(screen.getByTestId("day-timeline")).queryByText(/Edited 3 notes/)).toBeNull();
  });

  it("a note the server did not send is not on the timeline (read policy is the server's)", async () => {
    setData((s) => ({ ...s, nodes: [note(today)] }));
    render(<DayPane onOpenNode={props.onOpenNode} />);
    await screen.findByTestId("day-timeline");
    expect(screen.queryByText("secret")).toBeNull();
  });

  it("a timed task sits on the timeline; the pane has no list of its own for the untimed", () => {
    setData((s) => ({ ...s, nodes: [note(today), note("other", { title: "Weekend" })], tasks: [task("walk", today, { node_id: "other" }), task("call", today, { time: "23:00", node_id: "other" })] }));
    render(<DayPane onOpenNode={props.onOpenNode} />);
    const pane = screen.getByRole("region", { name: "Day timeline" });
    expect(within(pane).queryByRole("region", { name: "Not scheduled yet" })).toBeNull();
    expect(within(screen.getByTestId("day-timeline")).getByText("call")).toBeTruthy();
  });

  it("draws a red 「現在」 line on today", () => {
    setData((s) => ({ ...s, nodes: [note(today)] }));
    render(<DayPane onOpenNode={props.onOpenNode} />);
    expect(screen.getByRole("separator", { name: "Now" })).toBeTruthy();
  });

  it("the Journal page itself has no timeline to show or hide", () => {
    setData((s) => ({ ...s, nodes: [note(today)], tasks: [task("call", today, { time: "23:00" })] }));
    render(<JournalScreen {...props} />);
    expect(screen.queryByTestId("day-timeline")).toBeNull();
    expect(screen.queryByRole("region", { name: "Day timeline" })).toBeNull();
  });

  it("hides the hour label near now, and draws a short item as one compact line with its full text on hover", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${today}T12:00:00`) });
    const start = clockInstant(today, "12:05")!;
    // A task: the timeline lists only tasks and focus (onTimeline).
    lens.mockResolvedValue(dayLensOf(today, { items: [{ kind: "task", title: "short thing", at: start, until: clockInstant(today, "12:10")!, ref: { type: "task", id: "t2" }, past: false }] }));
    setData((s) => ({ ...s, nodes: [note(today)] }));
    const { container } = render(<DayPane onOpenNode={props.onOpenNode} />);
    const block = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".day-block.is-compact");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(block.getAttribute("title")).toMatch(/short thing/);
    const labels = [...container.querySelectorAll(".day-hour-label")].map((el) => el.textContent);
    expect(labels).not.toContain("12:00");
    expect(labels).toContain("13:00");
  });

  it("folds the empty stretches around now into one line each; now, the hour before and the hours coming up stay open", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${today}T12:00:00`) });
    lens.mockResolvedValue(dayLensOf(today, { items: [{ kind: "task", title: "lunch", at: clockInstant(today, "12:05")!, until: clockInstant(today, "12:30")!, ref: { type: "task", id: "t3" }, past: false }] }));
    setData((s) => ({ ...s, nodes: [note(today)] }));
    const { container } = render(<DayPane onOpenNode={props.onOpenNode} />);
    await waitFor(() => expect(container.querySelector(".day-block")).not.toBeNull());
    expect([...container.querySelectorAll(".day-fold")].map((el) => el.textContent)).toEqual(["00:00–11:00 empty · Show", "21:00–24:00 empty · Show"]);
    // The hours inside a fold have no line of their own.
    const labels = [...container.querySelectorAll(".day-hour-label")].map((el) => el.textContent);
    expect(labels).toContain("11:00");
    expect(labels).toContain("15:00");
    expect(labels).not.toContain("22:00");
    expect(labels).not.toContain("03:00");
    // The line that ends the day reads 24:00, as the fold above it does.
    expect(labels).toContain("24:00");
    expect(labels).not.toContain("00:00");
  });

  it("a fold opens on a tap, and only that one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${today}T12:00:00`) });
    setData((s) => ({ ...s, nodes: [note(today)] }));
    const { container } = render(<DayPane onOpenNode={props.onOpenNode} />);
    await screen.findByTestId("day-timeline");
    fireEvent.click(screen.getByRole("button", { name: "21:00–24:00 empty · Show" }));
    expect([...container.querySelectorAll(".day-fold")].map((el) => el.textContent)).toEqual(["00:00–11:00 empty · Show"]);
    expect([...container.querySelectorAll(".day-hour-label")].map((el) => el.textContent)).toContain("22:00");
  });

  it("scrolls the timeline to now when the day opens", () => {
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
    setData((s) => ({ ...s, nodes: [note(today)] }));
    render(<DayPane onOpenNode={props.onOpenNode} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

});

describe("the top bar's 「接下來」 tag", () => {
  it("shows the next timed task with the minutes left, and nothing without one", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-30T06:00:00Z") });
    const day = todayId();
    setData((s) => ({ ...s, workspace: { ...s.workspace, modules: ["daily", "tasks"] }, tasks: [task("call", day, { time: "23:00" })] }));
    const open = vi.fn();
    const { container, rerender } = render(<NextUpTag onOpen={open} />);
    expect(container.textContent).toMatch(/^23:00 call · in (\d+ h|\d+ min)$/);
    const tag = container.querySelector("button")!;
    expect(tag.title).toBe("Go to Tasks");
    tag.click();
    expect(open).toHaveBeenCalledTimes(1);
    setData((s) => ({ ...s, tasks: [task("untimed", day)] }));
    rerender(<NextUpTag onOpen={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("is not shown when the tasks module is off: it opens the Tasks page", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-30T06:00:00Z") });
    setData((s) => ({ ...s, workspace: { ...s.workspace, modules: ["daily"] }, tasks: [task("call", todayId(), { time: "23:00" })] }));
    const { container } = render(<NextUpTag onOpen={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

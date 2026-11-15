import { bindAccountStorage } from "../lib/accountStorage";
import { setPending } from "../lib/data/syncStatus";
import { getAppState, setAppState } from "../lib/appStore";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  upsertTask: vi.fn(async () => {}),
  removeTask: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
}));

// The registry supplies the "tasks" shell feature the page asks about.
import "../modules";
import TasksMode from "../modules/tasks/TasksMode";
import type { TaskRow } from "../lib/tasks/taskModel";

// A Saturday; the workspace has no zone set, so the browser's zone stands in
// and a noon instant is the same day everywhere.
const NOW = new Date("2026-10-24T12:00:00");

const note = (id: string, title: string) => ({ id, title, node_type: "content", source_type: "manual", slug: id, markdown: "" }) as ContentNode;
const NODES = [note("n1", "週末計畫"), note("n2", "讀書會")];
const TASKS: TaskRow[] = [
  { id: "a", node_id: null, title: "寄信給教授", status: "todo", when_date: "2026-10-24" },
  { id: "b", node_id: "n1", title: "買電池", status: "todo", when_date: "2026-10-20" },
  { id: "c", node_id: null, title: "洗衣服", status: "todo", when_date: "2026-10-24", evening: true },
  { id: "d", node_id: null, title: "交報告", status: "todo", when_date: "2026-11-02", deadline: "2026-10-26" },
  { id: "e", node_id: "n2", title: "澆花", status: "todo", when_date: "2026-10-26", recur: "1w", recur_mode: "after" },
  { id: "f", node_id: null, title: "整理書桌", status: "todo" },
  { id: "g", node_id: null, title: "學吉他", status: "todo", someday: true },
];

async function setup(tasks: TaskRow[] = TASKS) {
  setAppState({ data: { ...noWorkspaceData, nodes: NODES, tasks: tasks as never } });
  const onError = vi.fn();
  const onSelectNode = vi.fn();
  render(<TasksMode online onSelectNode={onSelectNode} onRefresh={() => {}} onError={onError} reminderPermission="unsupported" onEnableReminders={() => {}} />);
  // 今天 is the timeline (lazy); the strip of tasks with no slot is inside it.
  await screen.findByRole("region", { name: "Day timeline" });
  return { onError, onSelectNode };
}

const patches = () => apiMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
  .map(([path, init]) => [path, JSON.parse((init as RequestInit).body as string)] as const);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  bindAccountStorage("unit-test-account", "");
  setPending(0);
  setAppState({ toasts: [] });
  apiMock.mockReset();
  apiMock.mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

describe("task page tabs", () => {
  it("shows four tabs with open counts; 今天 has no explanation line (the tab already says it)", async () => {
    await setup();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Today4", "Coming up4", "Anytime1", "Someday1"]);
    expect(screen.getByRole("tab", { name: /Today/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText(/ones with a deadline coming up/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Coming up/ }));
    expect(screen.getByText(/they move to Today by themselves/)).toBeInTheDocument();
  });

  it("today has 「可以排進今天的」 (the late task) above one 「還沒排時間」 list (today's, tonight, the deadline two days off)", async () => {
    await setup();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Can go on today · 1", "Not scheduled yet3"]);
    expect(within(screen.getByRole("region", { name: "Can go on today · 1" })).getByText("買電池")).toBeInTheDocument(); // 10/20: late (4 days before the 24th)
    expect(within(screen.getByRole("region", { name: "Not scheduled yet" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByText(/Left over from /)).toHaveLength(1);
    expect(screen.getByText("Left over from Tue.")).toBeInTheDocument();
    expect(screen.getByText("洗衣服")).toBeInTheDocument();
    expect(screen.getByText("交報告")).toBeInTheDocument();
    expect(screen.queryByText("整理書桌")).toBeNull();
  });

  it("每個分頁各顯示自己的任務", async () => {
    await setup();
    fireEvent.click(screen.getByRole("tab", { name: /Coming up/ }));
    // One entry per day with something, starting on today; the days between are grey lines.
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Today 10/24 Sat.", "Mon. 10/26", "Mon. 11/2"]);
    expect(screen.getByText("Sun. 10/25 Nothing planned")).toBeInTheDocument();
    expect(screen.getByText("Tue. 10/27 – Sun. 11/1 Nothing planned")).toBeInTheDocument();
    expect(screen.getByText("Tue. 11/3 – Fri. 11/6 Nothing planned")).toBeInTheDocument();
    expect(screen.getByText("澆花")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Anytime/ }));
    expect(screen.getByText("整理書桌")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Someday/ }));
    expect(screen.getByText("學吉他")).toBeInTheDocument();
  });

  it("an evening task on a later day says Evening, not Tonight", async () => {
    await setup([{ id: "h", node_id: null, title: "看電影", status: "todo", when_date: "2026-10-26", evening: true }]);
    fireEvent.click(screen.getByRole("tab", { name: /Coming up/ }));
    const row = screen.getByText("看電影").closest("li")!;
    expect(row).toHaveTextContent("Evening");
    expect(row).not.toHaveTextContent("Tonight");
  });
});

describe("TaskRow, three sources", () => {
  it("a standalone task, a task in a note and a recurring one all draw the same row", async () => {
    await setup();
    const standalone = screen.getByText("寄信給教授", { selector: ".tk-title" }).closest("li")!;
    const inNote = screen.getByText("買電池").closest("li")!;
    for (const row of [standalone, inNote]) {
      expect(within(row).getByRole("checkbox")).toBeInTheDocument();
      expect(row.querySelector(".tk-main")).not.toBeNull();
    }
    expect(within(standalone).queryByText(/週末計畫/)).toBeNull();
    expect(within(inNote).getByText("From 週末計畫")).toBeInTheDocument();
    // 何時做 shows on the row outside 接下來, except when it is simply today; a past day reads as overdue
    expect(within(inNote).getByText("Left over from Tue.")).toBeInTheDocument();
    expect(within(standalone).queryByText("Today")).toBeNull();
    // deadline: solid within two days
    const soon = screen.getByText("交報告").closest("li")!;
    expect(within(soon).getByText(/Due/)).toHaveClass("tk-chip--deadline-soon");
    fireEvent.click(screen.getByRole("tab", { name: /Coming up/ }));
    const water = screen.getByText("澆花").closest("li")!;
    expect(within(water).getByText(/\(from completion\)/)).toHaveClass("tk-chip--recur");
  });

  it("the checkbox and the pills are at least 44px in CSS terms", () => {
    const css = readFileSync("src/modules/tasks/tasks.css", "utf8");
    expect(css).toMatch(/\.tk-box\s*\{[^}]*width:\s*44px/);
    expect(css).toMatch(/\.tk-pill\s*\{[^}]*min-height:\s*44px/);
  });
});

describe("completing", () => {
  it("strikes the row through, says the note line is ticked too, and undo reopens it", async () => {
    await setup();
    fireEvent.click(screen.getByLabelText("Mark 買電池 done"));
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/b", expect.objectContaining({ status: "done" })]));
    // stays on the page, struck through, until the tab changes
    const row = screen.getByText("買電池").closest("li")!;
    expect(row).toHaveClass("tk-row--done");
    const toast = getAppState().toasts.at(-1)!;
    expect(toast.message).toBe("Done “買電池”; the line in “週末計畫” is ticked too");
    toast.action!.onClick();
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/b", { status: "todo" }]));
    await waitFor(() => expect(screen.getByText("買電池").closest("li")).not.toHaveClass("tk-row--done"));
    // leaving the tab folds away a finished task
    fireEvent.click(screen.getByLabelText("Mark 買電池 done"));
    await waitFor(() => expect(screen.getByText("買電池").closest("li")).toHaveClass("tk-row--done"));
    fireEvent.click(screen.getByRole("tab", { name: /Anytime/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Today/ }));
    expect(screen.queryByText("買電池")).toBeNull();
  });

  it("a repeating task says when the next one comes", async () => {
    await setup();
    fireEvent.click(screen.getByRole("tab", { name: /Coming up/ }));
    fireEvent.click(screen.getByLabelText("Mark 澆花 done"));
    await waitFor(() => expect(getAppState().toasts.length).toBe(1));
    expect(getAppState().toasts[0]!.message).toMatch(/^Done “澆花”\. Next: /);
  });

  it("a refused write keeps the row open and reports once", async () => {
    apiMock.mockRejectedValue(new (await import("../lib/api")).ApiError(403, JSON.stringify({ error: "forbidden", detail: "no" })));
    const { onError } = await setup();
    fireEvent.click(screen.getByLabelText("Mark 寄信給教授 done"));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(getAppState().toasts).toEqual([]);
    expect(screen.getByText("寄信給教授", { selector: ".tk-title" }).closest("li")).not.toHaveClass("tk-row--done");
  });
});

describe("settings sheet", () => {
  const open = (title: string) => {
    // 整理書桌 lives on 隨時
    if (title === "整理書桌") fireEvent.click(screen.getByRole("tab", { name: /Anytime/ }));
    fireEvent.click(screen.getByLabelText(`Edit ${title}`));
  };

  it("says where the task lives and offers the right footer for each source", async () => {
    await setup();
    open("買電池");
    // Where it was written is the way to its note: no second 「開啟筆記」 button.
    expect(screen.getByRole("button", { name: "From 週末計畫" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Write details" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task title" }), { key: "Escape" });
  });

  it("a standalone task can open its own content", async () => {
    const { onSelectNode } = await setup();
    open("寄信給教授");
    expect(screen.getByText("A standalone task.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Write details" }));
    expect(onSelectNode).toHaveBeenCalledWith("a");
  });

  it("changing 何時做 writes the three fields and the task moves tab at once", async () => {
    await setup();
    open("寄信給教授");
    fireEvent.click(within(screen.getByRole("group", { name: "When" })).getByRole("button", { name: "Tomorrow" }));
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/a", {
      when_date: "2026-10-25", evening: false, someday: false,
    }]));
    // gone from 今天, present under 接下來
    await waitFor(() => expect(screen.queryByText("寄信給教授", { selector: ".tk-title" })).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /Coming up/ }));
    expect(screen.getByText("寄信給教授", { selector: ".tk-title" })).toBeInTheDocument();
  });

  it("someday and anytime move a task to their tabs", async () => {
    await setup();
    open("寄信給教授");
    fireEvent.click(screen.getAllByRole("button", { name: "Someday" })[0]!);
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/a", { when_date: null, evening: false, someday: true }]));
    fireEvent.click(screen.getByRole("tab", { name: /Someday/ }));
    expect(screen.getByText("寄信給教授", { selector: ".tk-title" })).toBeInTheDocument();
  });

  it("sets deadline, repeat and its counting mode, and reminder", async () => {
    await setup();
    open("整理書桌");
    // Each setting is one row: grey 「Not set」 until it has a value, its choices under it once opened.
    const row = (name: string) => within(screen.getByRole("group", { name }));
    const openRow = (name: string) => fireEvent.click(row(name).getAllByRole("button")[0]!);
    expect(row("Deadline").getByText("Not set")).toBeInTheDocument();
    expect(row("Deadline").queryByRole("button", { name: "Tomorrow" })).toBeNull();
    // No day and no deadline yet: 「that morning」 would not say which morning.
    openRow("Reminder");
    expect(row("Reminder").queryByRole("button", { name: "That morning, 9:00" })).toBeNull();
    openRow("Deadline");
    expect(row("Reminder").queryByRole("button", { name: "Pick a time…" })).toBeNull(); // one row open at a time
    const deadline = row("Deadline");
    fireEvent.click(deadline.getByRole("button", { name: "Tomorrow" }));
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/f", { deadline: "2026-10-25" }]));
    await waitFor(() => expect(row("Deadline").getByText("Tomorrow")).toBeInTheDocument());
    expect(row("Deadline").queryByRole("button", { name: "Today" })).toBeNull(); // a ready-made choice closes its row
    openRow("Repeat");
    fireEvent.click(row("Repeat").getByRole("button", { name: "Every week" }));
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/f", { recur: "1w" }]));
    // the counting-mode group only appears once a rule is set
    fireEvent.click(await screen.findByRole("button", { name: "From completion" }));
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/f", { recur_mode: "after" }]));
    expect(screen.getByText(/watering plants/)).toBeInTheDocument();
    openRow("Reminder");
    fireEvent.click(row("Reminder").getByRole("button", { name: "That morning, 9:00" }));
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/f", { remind_at: "2026-10-25T09:00" }]));
  });

  it("renames the task on blur but ignores an empty title", async () => {
    await setup();
    open("整理書桌");
    const title = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.change(title, { target: { value: "" } });
    fireEvent.blur(title);
    expect(title).toHaveValue("整理書桌");
    fireEvent.change(title, { target: { value: "整理房間" } });
    fireEvent.blur(title);
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/f", { title: "整理房間" }]));
  });

  it("the Complete button finishes the task and closes the sheet", async () => {
    await setup();
    open("整理書桌");
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(patches()).toContainEqual(["/api/tasks/f", { status: "done" }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

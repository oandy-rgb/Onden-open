// 接下來 as an agenda: the week row on top, a section per day, quiet days as a grey line, 「之後」 with dates on the left.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import UpcomingAgenda from "../modules/tasks/UpcomingAgenda";
import TaskRow from "../modules/tasks/TaskRow";
import { toTaskItem, type TaskItem } from "../lib/tasks";
import type { NodeTask } from "../lib/api";

const today = "2026-11-09"; // Monday
const item = (id: string, when: string, extra: Record<string, unknown> = {}): TaskItem =>
  toTaskItem({ id, node_id: null, title: id, status: "todo", when_date: when, ...extra } as NodeTask, () => undefined);
const row = (task: TaskItem) => <TaskRow key={task.id} task={task} today={today} showWhen={false} onToggle={vi.fn()} onOpen={vi.fn()} />;
const show = (tasks: TaskItem[]) => render(<UpcomingAgenda tasks={tasks} today={today} renderRow={row} />);

const scrollIntoView = vi.fn();
beforeEach(() => { scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView; });

describe("UpcomingAgenda", () => {
  it("draws nothing without a planned task", () => {
    const { container } = show([]);
    expect(container.firstChild).toBeNull();
  });

  it("sections: 今天 and 明天 name their date and weekday, the rest the weekday and date; a quiet run is one grey line", () => {
    show([item("a", today), item("b", "2026-11-10", { time: "09:00" }), item("c", "2026-11-13")]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Today 11/9 Mon.", "Tomorrow 11/10 Tue.", "Fri. 11/13"]);
    expect(screen.getByText("Wed. 11/11 – Thu. 11/12 Nothing planned")).toBeInTheDocument();
    expect(screen.getByText("Sat. 11/14 – Sun. 11/22 Nothing planned")).toBeInTheDocument();
    expect(screen.getByText("09:00")).toBeInTheDocument(); // the time, on the row's second line
  });

  it("the week row has seven days; a dot under the ones with something; a tap scrolls to that day, also one inside a quiet run", () => {
    show([item("a", today), item("c", "2026-11-13")]);
    const grid = screen.getByRole("grid", { name: "Next seven days" });
    const cells = within(grid).getAllByRole("gridcell");
    expect(cells).toHaveLength(7);
    expect(cells.filter((cell) => cell.classList.contains("has-things")).map((cell) => cell.textContent)).toEqual(["9", "13"]);
    fireEvent.click(cells[4]!);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("heading", { name: "Fri. 11/13" }).closest("section"));
    fireEvent.click(cells[2]!); // Wednesday: in the quiet run
    expect(scrollIntoView.mock.contexts[1]).toBe(screen.getByText(/^Tue\. 11\/10 – Thu\. 11\/12/).closest("p"));
  });

  it("past two weeks: 「之後」, each date on the left of its tasks", () => {
    show([item("near", "2026-11-12"), item("far", "2026-12-24"), item("farther", "2026-12-24"), item("later", "2027-01-05")]);
    const later = screen.getByRole("heading", { name: "After that" }).closest("section")!;
    const dates = [...later.querySelectorAll(".tk-agenda-date")].map((el) => el.textContent);
    expect(dates[0]).toBe("12/24");
    expect(dates[1]).toContain("2027"); // another year says so: 1/5 alone would read as next month
    expect(within(later).getAllByRole("listitem")).toHaveLength(3);
    expect(within(later).queryByText("near")).toBeNull();
  });
});

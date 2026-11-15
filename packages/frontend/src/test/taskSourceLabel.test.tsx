// The one wording of "where a task was written" (hostNoteLabel), and the two surfaces that draw it.
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { hostNoteLabel, taskDayItems } from "../lib/tasks";
import TaskRow from "../modules/tasks/TaskRow";
import type { TaskItem } from "../lib/tasks";

const TODAY = "2026-11-09";

describe("hostNoteLabel", () => {
  it("names a journal of another day by its date, with the year only when it is not this one", () => {
    expect(hostNoteLabel("2026-11-05", TODAY, TODAY)).toBe("From the 11/5 journal");
    expect(hostNoteLabel("2025-11-05", TODAY, TODAY)).toBe("From the 11/5/2025 journal");
  });
  it("names any other note by its title", () => {
    expect(hostNoteLabel("Weekend plans", TODAY, TODAY)).toBe("From Weekend plans");
  });
  it("says nothing for the day's own journal, or a task with no note", () => {
    expect(hostNoteLabel(TODAY, TODAY, TODAY)).toBeUndefined();
    expect(hostNoteLabel(undefined, TODAY, TODAY)).toBeUndefined();
    expect(hostNoteLabel("", TODAY, TODAY)).toBeUndefined();
  });
});

const item = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: "t1", title: "Buy batteries", status: "open", whenDate: TODAY, noteTitle: "2026-11-05", ...over,
} as TaskItem);

describe("TaskRow second line", () => {
  const draw = (task: TaskItem) => render(<ul><TaskRow task={task} today={TODAY} showWhen={false} onToggle={vi.fn()} onOpen={vi.fn()} /></ul>);
  it("says the task came from another day's journal, not a bare date", () => {
    draw(item());
    expect(screen.getByText("From the 11/5 journal")).toBeTruthy();
    expect(screen.queryByText("2026-11-05")).toBeNull();
  });
  it("is silent for a standalone task", () => {
    const { container } = draw(item({ noteTitle: "" }));
    expect(container.querySelector(".tk-note")).toBeNull();
  });
});

describe("timeline block detail", () => {
  it("uses the same wording", () => {
    const nodes = [{ id: "n1", title: "2026-11-05" }, { id: "n2", title: "Weekend plans" }] as never;
    const tasks = [
      { id: "a", node_id: "n1", title: "A", status: "open", when_date: TODAY },
      { id: "b", node_id: "n2", title: "B", status: "open", when_date: TODAY },
      { id: "c", node_id: null, title: "C", status: "open", when_date: TODAY },
    ] as never;
    const items = taskDayItems({ date: TODAY, today: TODAY, nodes, tasks, tags: [] });
    expect(items.map((i) => i.detail)).toEqual(["From the 11/5 journal", "From Weekend plans", undefined]);
  });
});

describe("timeline CSS", () => {
  const css = readFileSync("src/modules/daily/day/day.css", "utf8");
  it("gives the hour label a gutter wide enough for HH:MM, never wrapping", () => {
    expect(css).toMatch(/--day-gutter: 56px/);
    expect(css).toMatch(/\.day-hour-label \{[^}]*width: calc\(var\(--day-gutter\) - 8px\)[^}]*white-space: nowrap/);
  });
  it("keeps the focus button inside its block: 36px wide, no taller than the block", () => {
    const rule = css.match(/\.day-block-focus \{[^}]*\}/)![0];
    expect(rule).toMatch(/width: 36px/);
    expect(rule).toMatch(/--focus-h: min\(36px, var\(--h\)\)/);
    expect(rule).toMatch(/- 43px\)/);
    expect(css).toMatch(/\.day-block\.has-focus \{ padding-right: 44px/);
  });
});

import { setWorkspaceTimeZoneSource } from "../lib/localDate";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CalendarLayout from "../modules/calendar/CalendarLayout";
import {
  calendarDateField,
  bucketRowsByDay,
  monthLabel,
} from "../components/viewLayoutKit";
import type { ExecResponse } from "../lib/viewExec";
import type { ExecRow } from "@onden/contract";

function makeRow(id: string, title: string, attrs: Record<string, string | null> = {}, updated = "2026-06-10T08:00:00Z", created = "2026-06-01T08:00:00Z"): ExecRow {
  return { id, title, slug: id, created_at: created, updated_at: updated, attributes: attrs };
}

function makeExec(rows: ExecRow[], visibleFields: string[], dateField?: string): ExecResponse {
  return {
    rows,
    total: rows.length, next: null,
    view: { layout: "calendar", group_by: null, visible_fields: visibleFields, layout_config: dateField ? { date_field: dateField } : {} },
  };
}

describe("calendarGrid helpers", () => {
  it("places rows by the view's declared date field", () => {
    expect(calendarDateField("due_date")).toBe("due_date");
    expect(calendarDateField("created_at")).toBe("created_at");
  });

  it("uses the last-edited date when the view declares none — a field's name is never guessed at", () => {
    expect(calendarDateField(undefined)).toBe("updated_at");
    expect(calendarDateField("")).toBe("updated_at");
    expect(calendarDateField(7)).toBe("updated_at");
  });

  it("buckets rows by local day and drops missing/unparseable dates", () => {
    const rows = [
      makeRow("a", "A", { due_date: "2026-06-15T03:00:00Z" }),
      makeRow("b", "B", { due_date: "2026-06-15T20:00:00Z" }),
      makeRow("c", "C", { due_date: "" }),
      makeRow("d", "D", { due_date: "garbage" }),
    ];
    const buckets = bucketRowsByDay(rows, "due_date");
    const total = Array.from(buckets.values()).reduce((n, l) => n + l.length, 0);
    expect(total).toBe(2);
  });

  it("a plain date or wall-clock time keeps its own day; only a zoned timestamp is converted", () => {
    setWorkspaceTimeZoneSource(() => "America/Los_Angeles"); // west of UTC
    try {
      const buckets = bucketRowsByDay([
        makeRow("plain", "Plain", { due_date: "2026-10-14" }),
        makeRow("wall", "Wall", { due_date: "2026-10-14T00:30" }),
        makeRow("zoned", "Zoned", { due_date: "2026-10-15T03:00:00Z" }), // 10-14 20:00 in LA
      ], "due_date");
      expect(buckets.get("2026-10-14")?.map((r) => r.id).sort()).toEqual(["plain", "wall", "zoned"]);
    } finally {
      setWorkspaceTimeZoneSource(() => undefined);
    }
  });

  it("reads dates with the app's date grammar, not Date.parse (D81)", () => {
    // Date.parse accepts all four; only the last two name a calendar day.
    const rows = [
      makeRow("n", "Number", { due: "10" }),
      makeRow("d", "Draft", { due: "Draft 2" }),
      makeRow("w", "Written", { due: "Oct 14, 2026" }),
      makeRow("s", "Slashed", { due: "2026/10/14" }),
    ];
    const buckets = bucketRowsByDay(rows, "due", "UTC");
    expect([...buckets.keys()]).toEqual(["2026-10-14"]);
    expect(buckets.get("2026-10-14")?.map((r) => r.id)).toEqual(["w", "s"]);
  });

  it("places a zoned instant near midnight on its day in the workspace zone", () => {
    const rows = [makeRow("z", "Zoned", { due: "2026-10-13T16:30:00Z" })]; // 00:30 on the 14th in Taipei
    expect([...bucketRowsByDay(rows, "due", "Asia/Taipei").keys()]).toEqual(["2026-10-14"]);
    expect([...bucketRowsByDay(rows, "due", "UTC").keys()]).toEqual(["2026-10-13"]);
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    try {
      expect([...bucketRowsByDay(rows, "due").keys()]).toEqual(["2026-10-14"]);
    } finally {
      setWorkspaceTimeZoneSource(() => undefined);
    }
  });

  it("places rows by the created date: created_at is on the row, like updated_at", () => {
    const rows = [
      makeRow("a", "A", {}, "2026-06-20T08:00:00.000Z", "2026-06-02T08:00:00.000Z"),
      makeRow("b", "B", {}, "2026-06-21T08:00:00.000Z", "2026-06-02T09:00:00.000Z"),
    ];
    const byCreated = bucketRowsByDay(rows, "created_at", "UTC");
    expect([...byCreated.keys()]).toEqual(["2026-06-02"]);
    expect(byCreated.get("2026-06-02")?.map((r) => r.id)).toEqual(["a", "b"]);
    expect([...bucketRowsByDay(rows, "updated_at", "UTC").keys()]).toEqual(["2026-06-20", "2026-06-21"]);
  });

  it("monthLabel formats as expected", () => {
    expect(monthLabel(2026, 5)).toMatch(/2026/);
  });
});

describe("CalendarLayout component", () => {
  it("renders an empty-state message when no rows", () => {
    render(<CalendarLayout exec={makeExec([], ["title"])} />);
    expect(screen.getByText(/no rows match/i)).toBeInTheDocument();
  });

  it("renders weekday headers and a current-month grid", () => {
    vi.setSystemTime(new Date(2026, 5, 13));
    const rows = [makeRow("a", "Launch", { due_date: "2026-06-13" })];
    render(<CalendarLayout exec={makeExec(rows, ["title", "due_date"])} />);
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();
    expect(screen.getByText("Launch")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("fires onSelectNode when a day chip is clicked", () => {
    vi.setSystemTime(new Date(2026, 5, 13));
    const onSelect = vi.fn();
    const rows = [makeRow("n1", "Standup", { due_date: "2026-06-13" })];
    render(<CalendarLayout exec={makeExec(rows, ["title", "due_date"])} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByText("Standup"));
    expect(onSelect).toHaveBeenCalledWith("n1");
    vi.useRealTimers();
  });

  it("navigates to the next month with the chevron", () => {
    vi.setSystemTime(new Date(2026, 5, 13));
    render(<CalendarLayout exec={makeExec([makeRow("a", "A", { due_date: "2026-06-13" })], ["title", "due_date"])} />);
    expect(screen.getByText(monthLabel(2026, 5))).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Next month"));
    expect(screen.getByText(monthLabel(2026, 6))).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("notes rows that have no date for the chosen field", () => {
    vi.setSystemTime(new Date(2026, 5, 13));
    const rows = [
      makeRow("a", "Has date", { due_date: "2026-06-13" }),
      makeRow("b", "No date", { due_date: "" }),
    ];
    render(<CalendarLayout exec={makeExec(rows, ["title", "due_date"], "due_date")} />);
    expect(screen.getByText(/aren.t shown on the grid/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("counts values that name no day as undated and places 2026/10/14 on the 14th (D81)", () => {
    vi.setSystemTime(new Date(2026, 9, 13));
    const rows = [
      makeRow("n", "Number", { due: "10" }),
      makeRow("d", "Draft", { due: "Draft 2" }),
      makeRow("w", "Written", { due: "Oct 14, 2026" }),
      makeRow("s", "Slashed", { due: "2026/10/14" }),
      makeRow("i", "Iso", { due: "2026-10-20" }),
    ];
    render(<CalendarLayout exec={makeExec(rows, ["title", "due"], "due")} />);
    expect(screen.getByText(/2 of 5 rows have no .due. date/)).toBeInTheDocument();
    const dayOf = (title: string) =>
      screen.getByText(title).closest("[role=gridcell]")?.querySelector(".cv-cal-daynum")?.textContent;
    expect(dayOf("Slashed")).toBe("14");
    expect(dayOf("Written")).toBe("14");
    expect(screen.queryByText("Number")).toBeNull();
    expect(screen.queryByText("Draft")).toBeNull();
    vi.useRealTimers();
  });

  it("「+N more」 opens the day in place, and closes it again", () => {
    vi.setSystemTime(new Date(2026, 5, 13));
    const rows = ["A", "B", "C", "D", "E"].map((title) => makeRow(title, `Task ${title}`, { due_date: "2026-06-15" }));
    render(<CalendarLayout exec={makeExec(rows, ["title", "due_date"])} />);
    expect(screen.queryByText("Task E")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(screen.getByText("Task D")).toBeInTheDocument();
    expect(screen.getByText("Task E")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("Task E")).toBeNull();
    vi.useRealTimers();
  });

  it("remembers the month a view was moved to; 「Today」 forgets it", () => {
    vi.setSystemTime(new Date(2026, 5, 13));
    localStorage.removeItem("onden.calendarMonths");
    const exec = makeExec([makeRow("a", "A", { due_date: "2026-06-13" })], ["title", "due_date"]);
    const first = render(<CalendarLayout viewId="v1" exec={exec} />);
    fireEvent.click(screen.getByLabelText("Next month"));
    fireEvent.click(screen.getByLabelText("Next month"));
    first.unmount();
    const second = render(<CalendarLayout viewId="v1" exec={exec} />);
    expect(screen.getByText(monthLabel(2026, 7))).toBeInTheDocument();
    // Another view keeps its own month.
    second.unmount();
    const other = render(<CalendarLayout viewId="v2" exec={exec} />);
    expect(screen.getByText(monthLabel(2026, 5))).toBeInTheDocument();
    other.unmount();
    render(<CalendarLayout viewId="v1" exec={exec} />);
    fireEvent.click(screen.getByText("Today"));
    expect(screen.getByText(monthLabel(2026, 5))).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("onden.calendarMonths") ?? "{}")).toEqual({});
    vi.useRealTimers();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import KanbanLayout, { pickGroupField } from "../modules/kanban/KanbanLayout";
import TableLayout from "../modules/table/TableLayout";
import type { ExecResponse } from "../lib/viewExec";
import { propertyWriter } from "../lib/data";
import type { ExecRow } from "@onden/contract";

function makeRow(id: string, title: string, attributes: Record<string, string | null> = {}): ExecRow {
  return { id, title, slug: id, created_at: "2025-12-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", attributes };
}

function makeExec(rows: ExecRow[], view: Partial<ExecResponse["view"]> = {}): ExecResponse {
  return {
    rows,
    total: rows.length, next: null,
    view: {
      layout: "kanban",
      group_by: null,
      visible_fields: ["title", "status"],
      layout_config: {},
      ...view,
    },
  };
}

describe("pickGroupField", () => {
  it("prefers explicit group_by", () => {
    expect(pickGroupField(makeExec([]).view)).toBe("status");
    expect(
      pickGroupField(makeExec([], { group_by: "priority", visible_fields: ["title", "status"] }).view),
    ).toBe("priority");
  });

  it("falls back to first non-built-in visible field", () => {
    expect(
      pickGroupField(makeExec([], { visible_fields: ["title", "updated_at", "stage"] }).view),
    ).toBe("stage");
  });

  it("returns null when no groupable field exists", () => {
    expect(
      pickGroupField(makeExec([], { visible_fields: ["title", "updated_at"] }).view),
    ).toBeNull();
  });
});

// D78: Kanban and Table / List used to group with two different helpers.
describe("Kanban / Table / List grouping parity", () => {
  const headers = (container: HTMLElement, selector: string) =>
    Array.from(container.querySelectorAll(selector)).map((el) => el.textContent);

  const views = (exec: ExecResponse) => {
    const kanban = render(<KanbanLayout exec={exec} />).container;
    const table = render(<TableLayout exec={exec} />).container;
    return {
      kanban: headers(kanban, ".cv-kanban-col-title"),
      table: headers(table, ".cv-group-val"),
    };
  };

  it("orders groups by the declared options in every layout, whatever the sort", () => {
    // View sorted by title: A=done, B=todo, C=doing (+ one empty row).
    const exec = makeExec(
      [
        makeRow("A", "A", { status: "done" }),
        makeRow("B", "B", { status: "todo" }),
        makeRow("D", "D", {}),
        makeRow("C", "C", { status: "doing" }),
      ],
      { group_by: "status", group_field_options: ["todo", "doing", "done"] },
    );
    const { kanban, table } = views(exec);
    expect(kanban).toEqual(["todo", "doing", "done", "No value"]);
    expect(table).toEqual(kanban);
  });

  it("gives a literal \"(none)\" value its own group in every layout", () => {
    const exec = makeExec(
      [makeRow("a", "A", { status: "(none)" }), makeRow("b", "B", {})],
      { group_by: "status" },
    );
    const { kanban, table } = views(exec);
    expect(kanban).toEqual(["(none)", "No value"]);
    expect(table).toEqual(kanban);
  });
});

describe("KanbanLayout card moves", () => {
  it("writes the target column's value — \"\" for No value, the text for a \"(none)\" column", async () => {
    const set = vi.spyOn(propertyWriter, "set").mockResolvedValue(undefined as never);
    try {
      const exec = makeExec(
        [makeRow("a", "A", { status: "(none)" }), makeRow("b", "B", {})],
        { group_by: "status" },
      );
      render(<KanbanLayout exec={exec} />);
      const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
      const noValueKey = Array.from(selects[0].options).find((o) => o.text === "No value")!.value;
      const noneKey = Array.from(selects[0].options).find((o) => o.text === "(none)")!.value;

      fireEvent.change(selects[0], { target: { value: noValueKey } }); // card A → No value
      await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
      expect(set).toHaveBeenLastCalledWith("a", "status", "");
      await waitFor(() => expect(selects[1].disabled).toBe(false));

      fireEvent.change(selects[1], { target: { value: noneKey } }); // card B → "(none)"
      await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
      expect(set).toHaveBeenLastCalledWith("b", "status", "(none)");
    } finally {
      set.mockRestore();
    }
  });
});

describe("KanbanLayout", () => {
  it("renders a column per distinct group value with cards and counts", () => {
    const exec = makeExec([
      makeRow("a", "Buy milk", { status: "todo" }),
      makeRow("b", "Ship it", { status: "done" }),
      makeRow("c", "Write tests", { status: "todo" }),
    ]);
    const { container } = render(<KanbanLayout exec={exec} />);
    // Column titles live in .cv-kanban-col-title; the a11y "Move to column"
    // <select> on each card also lists todo/done as <option>s, so query the
    // headers by class rather than by bare text (which would be ambiguous).
    const colTitles = Array.from(container.querySelectorAll(".cv-kanban-col-title")).map((el) => el.textContent);
    expect(colTitles).toEqual(["todo", "done"]);
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByText("Write tests")).toBeInTheDocument();
    expect(screen.getByText("Ship it")).toBeInTheDocument();

    const todoTitle = Array.from(container.querySelectorAll(".cv-kanban-col-title")).find((el) => el.textContent === "todo") as HTMLElement;
    const todoCol = todoTitle.closest(".cv-kanban-col") as HTMLElement;
    expect(within(todoCol).getByText("2")).toBeInTheDocument();
  });

  it("renders columns in the group field's declared option order", () => {
    const exec = makeExec(
      [
        makeRow("a", "Closed deal", { stage: "Won" }),
        makeRow("b", "New lead", { stage: "Lead" }),
        makeRow("c", "Vetted", { stage: "Qualified" }),
      ],
      { group_by: "stage", group_field_options: ["Lead", "Qualified", "Won"], visible_fields: ["title", "stage"] },
    );
    const { container } = render(<KanbanLayout exec={exec} />);
    // Scope to the column headers — the a11y "Move to column" <select> on each
    // card also carries Lead/Qualified/Won <option>s, so a bare text query would
    // match those too.
    const titles = Array.from(container.querySelectorAll(".cv-kanban-col-title")).map((el) => el.textContent);
    expect(titles).toEqual(["Lead", "Qualified", "Won"]);
  });

  it("calls onSelectNode when a card title is clicked", () => {
    const onSelect = vi.fn();
    const exec = makeExec([makeRow("a", "Open me", { status: "todo" })]);
    render(<KanbanLayout exec={exec} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByText("Open me"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("shows a guidance message when no groupable field exists", () => {
    const exec = makeExec([makeRow("a", "A")], { visible_fields: ["title", "updated_at"] });
    render(<KanbanLayout exec={exec} />);
    expect(screen.getByText(/needs a field to group by/i)).toBeInTheDocument();
  });

  it("shows empty-state when there are no rows", () => {
    render(<KanbanLayout exec={makeExec([])} />);
    expect(screen.getByText(/no rows match/i)).toBeInTheDocument();
  });
});

describe("Kanban card badges", () => {
  it("name a built-in field in words, never by its stored key", () => {
    const exec = makeExec([makeRow("a", "Alpha", { status: "todo", owner: "Ann" })], {
      visible_fields: ["title", "status", "updated_at", "created_at", "owner"],
    });
    const { container } = render(<KanbanLayout exec={exec} />);
    const keys = Array.from(container.querySelectorAll(".cv-kanban-badge-key")).map((el) => el.textContent);
    expect(keys).toEqual(["Updated at", "Created at", "owner"]);
    const titles = Array.from(container.querySelectorAll(".cv-kanban-badge")).map((el) => el.getAttribute("title"));
    expect(titles).toEqual(["Updated at", "Created at", "owner"]);
    expect(container.textContent).not.toContain("updated_at");
    expect(container.textContent).not.toContain("created_at");
  });
});

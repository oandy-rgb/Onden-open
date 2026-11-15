import { bindAccountStorage } from "../lib/accountStorage";
import { setAppState } from "../lib/appStore";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null), upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}) }));
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// a11y (kanban-cards-mouse-only-a11y): native HTML5 drag is mouse-only, so each
// card carries a keyboard/screen-reader-accessible "Move to column" <select>.
// Choosing a column commits the SAME attribute-set as a drop — one PUT through
// the shared api() helper (PUT /api/nodes/:id/attributes/:key → spine mutate),
// then onMutated re-runs the query. We spy on api() rather than touch a backend.
const apiMock = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({}));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: (path: string, init?: RequestInit) => apiMock(path, init) };
});

import KanbanLayout from "../modules/kanban/KanbanLayout";
import { groupKey } from "../components/viewLayoutKit";
import type { ExecResponse } from "../lib/viewExec";
import type { ExecRow } from "@onden/contract";

function makeRow(id: string, title: string, attributes: Record<string, string | null> = {}): ExecRow {
  return { id, title, slug: id, created_at: "2025-12-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", attributes };
}

function makeExec(rows: ExecRow[]): ExecResponse {
  return {
    rows,
    total: rows.length, next: null,
    view: { layout: "kanban", group_by: "status", visible_fields: ["title", "status"], layout_config: {} },
  };
}

describe("Kanban keyboard / screen-reader move control", () => {
  beforeEach(() => {
    setAppState({ online: true });
    apiMock.mockClear();
    apiMock.mockResolvedValue({});
  });

  it("exposes a labelled move-to-column select per card", () => {
    const exec = makeExec([
      makeRow("a", "Buy milk", { status: "todo" }),
      makeRow("b", "Ship it", { status: "done" }),
    ]);
    render(<KanbanLayout exec={exec} onMutated={vi.fn()} />);

    // Accessible name comes from the (visually-hidden) label, not a placeholder.
    const select = screen.getByRole("combobox", { name: /move buy milk to column/i }) as HTMLSelectElement;
    // Options mirror the columns (value = the column's group key); the current
    // column is the selected value.
    expect([...select.options].map((o) => o.text)).toEqual(["todo", "done"]);
    expect([...select.options].map((o) => o.value)).toEqual([groupKey("todo"), groupKey("done")]);
    expect(select.value).toBe(groupKey("todo"));
  });

  it("choosing another column writes the grouping field and refreshes", async () => {
    const onMutated = vi.fn();
    const exec = makeExec([
      makeRow("a", "Buy milk", { status: "todo" }),
      makeRow("b", "Ship it", { status: "done" }),
    ]);
    render(<KanbanLayout exec={exec} onMutated={onMutated} />);

    const select = screen.getByRole("combobox", { name: /move buy milk to column/i });
    fireEvent.change(select, { target: { value: groupKey("done") } });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe("/api/nodes/a/attributes/status");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toMatchObject({ value: "done" });
    expect(JSON.parse(init?.body as string)).not.toHaveProperty("value_type"); // the server keeps the row's own type (scan 06 M1)
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("choosing the No value column clears the field", async () => {
    const exec = makeExec([
      makeRow("a", "Buy milk", { status: "todo" }),
      makeRow("z", "Untriaged", { status: "" }),
    ]);
    render(<KanbanLayout exec={exec} onMutated={vi.fn()} />);

    const select = screen.getByRole("combobox", { name: /move buy milk to column/i }) as HTMLSelectElement;
    // The "No value" column key is the sentinel; pick it by its visible label.
    const noValueOpt = [...select.options].find((o) => o.text === "No value");
    expect(noValueOpt).toBeTruthy();
    fireEvent.change(select, { target: { value: noValueOpt!.value } });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(apiMock.mock.calls[0][1]?.body as string)).toMatchObject({ value: "" });
  });

  it("selecting the current column is a no-op (no write)", async () => {
    const exec = makeExec([makeRow("a", "Buy milk", { status: "todo" })]);
    render(<KanbanLayout exec={exec} onMutated={vi.fn()} />);

    const select = screen.getByRole("combobox", { name: /move buy milk to column/i });
    fireEvent.change(select, { target: { value: groupKey("todo") } });

    await Promise.resolve();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });

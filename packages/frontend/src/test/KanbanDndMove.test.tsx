import { bindAccountStorage } from "../lib/accountStorage";
import { setAppState } from "../lib/appStore";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null), upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}) }));
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Dragging a card to another column persists by writing the grouping field to
// the drop column's value — one attribute-set through the shared api() helper
// (PUT /api/nodes/:id/attributes/:key → spine mutate), then onMutated re-runs
// the query. We spy on api() rather than touch a real backend.
// Pattern: dnd-kit kanban (MIT, /tmp/featlibs/INDEX.md) — drop column id IS the
// new single-select value — implemented with native HTML5 drag (no new dep).
const apiMock = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({}));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: (path: string, init?: RequestInit) => apiMock(path, init) };
});

import KanbanLayout from "../modules/kanban/KanbanLayout";
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

// jsdom drag events don't carry a dataTransfer by default — supply a stub so
// onDragStart can call setData/effectAllowed without throwing.
function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: "",
    setData: (k: string, v: string) => { store[k] = v; },
    getData: (k: string) => store[k] ?? "",
  } as unknown as DataTransfer;
}

describe("Kanban drag-to-move persistence", () => {
  beforeEach(() => {
    setAppState({ online: true });
    apiMock.mockClear();
    apiMock.mockResolvedValue({});
  });

  it("writes the new column value to the grouping field and refreshes", async () => {
    const onMutated = vi.fn();
    const exec = makeExec([
      makeRow("a", "Buy milk", { status: "todo" }),
      makeRow("b", "Ship it", { status: "done" }),
    ]);
    render(<KanbanLayout exec={exec} onMutated={onMutated} />);

    const card = screen.getByText("Buy milk").closest(".cv-kanban-card") as HTMLElement;
    // Column header (not the per-card move-<select> option, which shares the text).
    const doneCol = screen
      .getByText("done", { selector: ".cv-kanban-col-title" })
      .closest(".cv-kanban-col") as HTMLElement;
    const dt = dataTransfer();

    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(doneCol, { dataTransfer: dt });
    fireEvent.drop(doneCol, { dataTransfer: dt });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe("/api/nodes/a/attributes/status");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toMatchObject({ value: "done" });
    expect(JSON.parse(init?.body as string)).not.toHaveProperty("value_type"); // the server keeps the row's own type (scan 06 M1)
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("dropping onto the same column is a no-op (no write)", async () => {
    const exec = makeExec([makeRow("a", "Buy milk", { status: "todo" })]);
    render(<KanbanLayout exec={exec} onMutated={vi.fn()} />);

    const card = screen.getByText("Buy milk").closest(".cv-kanban-card") as HTMLElement;
    const todoCol = screen
      .getByText("todo", { selector: ".cv-kanban-col-title" })
      .closest(".cv-kanban-col") as HTMLElement;
    const dt = dataTransfer();

    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.drop(todoCol, { dataTransfer: dt });

    // Give any async path a tick; assert nothing was written.
    await Promise.resolve();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("dropping onto the No value column clears the field", async () => {
    const exec = makeExec([
      makeRow("a", "Buy milk", { status: "todo" }),
      makeRow("z", "Untriaged", { status: "" }),
    ]);
    render(<KanbanLayout exec={exec} onMutated={vi.fn()} />);

    const card = screen.getByText("Buy milk").closest(".cv-kanban-card") as HTMLElement;
    const noValueCol = screen
      .getByText("No value", { selector: ".cv-kanban-col-title" })
      .closest(".cv-kanban-col") as HTMLElement;
    const dt = dataTransfer();

    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.drop(noValueCol, { dataTransfer: dt });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(apiMock.mock.calls[0][1]?.body as string)).toMatchObject({ value: "" });
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });

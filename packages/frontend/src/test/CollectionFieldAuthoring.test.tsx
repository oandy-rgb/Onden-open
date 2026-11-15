// collection-field-authoring — the filter/sort/group builder + rollup &
// rating field authoring all write through EXISTING mutation paths (the views
// PATCH route and the schema FieldDef shape). These tests pin the wire
// contracts: what the builder PATCHes, what the schema editor stores for a
// rollup/rating field, and what a star click saves.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ViewBuilder from "../components/collections/ViewBuilder";
import type { SavedView } from "../components/collections/CollectionView";
import { SchemaEditor, type FieldDef } from "../components/TagsPanel";
import { SchemaRow } from "../components/attributes/SchemaRow";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: vi.fn(async () => ({})) };
});
// View changes go through the view writer: record them at its submit boundary.
const submitted = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body: Record<string, unknown> }> }));
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    submitted.calls.push({ method: r.method, path: r.path, body: JSON.parse(r.body ?? "{}") });
    return { status: "synced", value: {} };
  },
}));

const VIEW: SavedView = {
  id: "view-1",
  tag_id: "tag-1",
  name: "Invoices",
  layout: "table",
  filters: [],
  sorts: [],
  group_by: null,
  visible_fields: ["title", "amount", "status"],
  layout_config: {},
  pin_order: 0,
};

describe("ViewBuilder — filter/sort/group authoring (PATCH /views/:id)", () => {
  beforeEach(() => { vi.clearAllMocks(); submitted.calls.length = 0; });

  it("keeps a range filter (gt) an agent saved: shown as such, and kept on the next save", async () => {
    const ranged = { ...VIEW, filters: [{ field: "amount", op: "gt", value: "100" }] };
    render(<ViewBuilder owner={{ kind: "tag", id: "tag-1" }} view={ranged} fieldKeys={["amount", "status"]} onSaved={() => {}} />);
    const ops = screen.getAllByRole("combobox").filter((el) => (el as HTMLSelectElement).classList.contains("cv-builder-op"));
    expect((ops[0] as HTMLSelectElement).value).toBe("gt");

    fireEvent.click(screen.getByText(/Add filter/i));
    await waitFor(() => expect(submitted.calls).toHaveLength(1));
    expect((submitted.calls[0]!.body.filters as Array<Record<string, unknown>>)[0]).toEqual({ field: "amount", op: "gt", value: "100" });
  });

  it("adding a filter PATCHes the view with a clause carrying field/op/value", async () => {
    render(<ViewBuilder owner={{ kind: "tag", id: "tag-1" }} view={VIEW} fieldKeys={["amount", "status"]} onSaved={() => {}} />);

    fireEvent.click(screen.getByText(/Add filter/i));

    await waitFor(() => expect(submitted.calls).toHaveLength(1));
    const { path, method, body } = submitted.calls[0]!;
    expect(path).toBe("/api/tags/tag-1/views/view-1");
    expect(method).toBe("PATCH");
    const filters = body.filters as Array<Record<string, unknown>>;
    expect(Array.isArray(filters)).toBe(true);
    expect(filters[0]).toMatchObject({ op: "contains" });
    expect(typeof filters[0]!.field).toBe("string");
  });

  it("choosing a group-by field PATCHes group_by", async () => {
    render(<ViewBuilder owner={{ kind: "tag", id: "tag-1" }} view={VIEW} fieldKeys={["amount", "status"]} onSaved={() => {}} />);

    // The last <select> on screen is the group-by picker.
    const selects = screen.getAllByRole("combobox");
    const groupSelect = selects[selects.length - 1]!;
    fireEvent.change(groupSelect, { target: { value: "status" } });

    await waitFor(() => expect(submitted.calls).toHaveLength(1));
    expect(submitted.calls[0]!.body.group_by).toBe("status");
  });

  it("grouping by a field the view does not show also shows it, as a board's columns field does (placementChanges)", async () => {
    const view = { ...VIEW, visible_fields: ["title", "amount"] };
    render(<ViewBuilder owner={{ kind: "tag", id: "tag-1" }} view={view} fieldKeys={["amount", "status"]} onSaved={() => {}} />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[selects.length - 1]!, { target: { value: "status" } });
    await waitFor(() => expect(submitted.calls).toHaveLength(1));
    expect(submitted.calls[0]!.body).toEqual({ group_by: "status", visible_fields: ["title", "amount", "status"] });
  });

  it("clearing the grouping leaves the shown fields alone", async () => {
    const view = { ...VIEW, group_by: "status", visible_fields: ["title"] };
    render(<ViewBuilder owner={{ kind: "tag", id: "tag-1" }} view={view} fieldKeys={["amount", "status"]} onSaved={() => {}} />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[selects.length - 1]!, { target: { value: "" } });
    await waitFor(() => expect(submitted.calls).toHaveLength(1));
    expect(submitted.calls[0]!.body).toEqual({ group_by: null });
  });

  // GAP-123: two different changes inside one debounce window used to send
  // only the second, losing the first.
  it("changes made within one debounce window are sent together", async () => {
    const view = { ...VIEW, filters: [{ field: "amount", op: "contains", value: "1" }] };
    render(<ViewBuilder owner={{ kind: "tag", id: "tag-1" }} view={view} fieldKeys={["amount", "status"]} onSaved={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: /remove filter/i })[0]!);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[selects.length - 1]!, { target: { value: "status" } });
    await waitFor(() => expect(submitted.calls).toHaveLength(1));
    expect(submitted.calls[0]!.body).toEqual({ filters: [], group_by: "status" });
  });
});

describe("SchemaEditor — rollup field authoring", () => {
  it("switching a field to rollup stores an aggregation op (not a plain value)", () => {
    const fields: FieldDef[] = [{ name: "total_hours", type: "number" }];
    let next: FieldDef[] = [];
    render(<SchemaEditor fields={fields} onChange={(f) => { next = f; }} />);

    // The type select offers a plain "Calculated (auto-total)" option that
    // still writes the underlying `rollup` config.
    const typeSelect = screen.getByDisplayValue("number");
    fireEvent.change(typeSelect, { target: { value: "rollup" } });

    expect(next[0]).toMatchObject({ rollup: { op: "count" } });
  });

  it("a sum rollup keeps an attr key to aggregate", () => {
    const fields: FieldDef[] = [{ name: "total_hours", type: "number", rollup: { op: "sum", attr: "hours" } } as FieldDef];
    let next: FieldDef[] = [];
    render(<SchemaEditor fields={fields} onChange={(f) => { next = f; }} />);

    // The "What to calculate" select is on the sum op; switching to max keeps
    // the attr (the displayed label is de-jargoned, but the value is the op).
    const opSelect = screen.getByTitle(/what to calculate/i);
    fireEvent.change(opSelect, { target: { value: "max" } });
    expect((next[0] as FieldDef & { rollup?: { op: string; attr?: string } }).rollup).toMatchObject({ op: "max", attr: "hours" });
  });
});

describe("SchemaRow — rating widget", () => {
  it("renders a star scale sized to field.max and saves the clicked star", () => {
    const onSave = vi.fn();
    const field = { name: "score", type: "rating", max: 4 } as FieldDef;
    render(<table><tbody><tr><SchemaRow field={field} value="2" allNodes={[]} onSave={onSave} /></tr></tbody></table>);

    const stars = screen.getAllByRole("radio");
    expect(stars).toHaveLength(4);
    // value "2" → first two stars on.
    expect(stars[1]!.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(stars[3]!); // click the 4th star
    expect(onSave).toHaveBeenCalledWith("4");
  });

  it("clicking the current rating clears it (toggle to empty)", () => {
    const onSave = vi.fn();
    const field = { name: "score", type: "rating" } as FieldDef; // default max 5
    render(<table><tbody><tr><SchemaRow field={field} value="3" allNodes={[]} onSave={onSave} /></tr></tbody></table>);
    const stars = screen.getAllByRole("radio");
    expect(stars).toHaveLength(5);
    fireEvent.click(stars[2]!); // the 3rd star == current rating
    // The shared StarRating widget clears to "" (delete-shaped attribute write),
    // which parseRating reads back as 0 — same outcome, no literal-0 row left.
    expect(onSave).toHaveBeenCalledWith("");
  });
});

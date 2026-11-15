import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// inline-add-row: the in-view quick-add row creates a real note WITH the
// collection's class tag in one request (it can never exist untagged, GAP-125),
// then asks the caller to re-run the view query. A retry of the same title
// reuses the note id, so a lost response cannot make a second row.

const submitted = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>, fail: [] as unknown[] }));
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const body = JSON.parse(r.body ?? "{}");
    submitted.calls.push({ method: r.method, path: r.path, body });
    const failure = submitted.fail.shift();
    if (failure) throw failure;
    return { status: "synced", value: body };
  },
}));
vi.mock("../lib/localDb", () => ({ upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), upsertAttribute: vi.fn(async () => {}) }));

import { ApiError } from "../lib/api";
import QuickAddRow from "../components/collections/QuickAddRow";

describe("QuickAddRow", () => {
  beforeEach(() => { submitted.calls.length = 0; submitted.fail = []; });

  it("creates the note with the collection tag in one request and refreshes on Enter", async () => {
    const onCreated = vi.fn();
    render(<QuickAddRow source={{ kind: "tag", id: "tag-42", name: "book" }} onCreated={onCreated} />);
    const input = screen.getByLabelText("Add a new note to #book") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Dune" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(submitted.calls).toHaveLength(1);
    expect(submitted.calls[0]).toMatchObject({ method: "POST", path: "/api/nodes", body: { title: "Dune", markdown: "", tag_ids: ["tag-42"] } });
    expect(input.value).toBe("");
  });

  it("on a note's views it makes a sub-note of that note, untagged", async () => {
    const onCreated = vi.fn();
    render(<QuickAddRow source={{ kind: "node", id: "parent-1", name: "Reading list" }} onCreated={onCreated} />);
    // A note's views end in a slim row; pressing it opens the input.
    fireEvent.click(screen.getByRole("button", { name: "New sub-note" }));
    const input = screen.getByLabelText("Add a new sub-note to Reading list");
    fireEvent.change(input, { target: { value: "Emma" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(submitted.calls[0]).toMatchObject({ method: "POST", path: "/api/nodes", body: { title: "Emma", parent_id: "parent-1" } });
    expect(submitted.calls[0]!.body.tag_ids ?? []).toEqual([]);
  });

  it("ignores empty / whitespace-only titles", () => {
    const onCreated = vi.fn();
    render(<QuickAddRow source={{ kind: "tag", id: "t", name: "book" }} onCreated={onCreated} />);
    const input = screen.getByLabelText("Add a new note to #book");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitted.calls).toHaveLength(0);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("surfaces an error, keeps the title, and does not refresh when create is refused", async () => {
    submitted.fail = [new ApiError(403, "forbidden")];
    const onCreated = vi.fn();
    render(<QuickAddRow source={{ kind: "tag", id: "t", name: "book" }} onCreated={onCreated} />);
    const input = screen.getByLabelText("Add a new note to #book") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Dune" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/permission/i)).toBeInTheDocument());
    expect(onCreated).not.toHaveBeenCalled();
    expect(input.value).toBe("Dune");
  });

  it("a retry after an unconfirmed create reuses the same note id (no second row)", async () => {
    submitted.fail = [new TypeError("Failed to fetch")];
    const onCreated = vi.fn();
    render(<QuickAddRow source={{ kind: "tag", id: "t", name: "book" }} onCreated={onCreated} />);
    const input = screen.getByLabelText("Add a new note to #book");
    fireEvent.change(input, { target: { value: "Dune" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitted.calls).toHaveLength(1));
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(submitted.calls[1]!.body.id).toBe(submitted.calls[0]!.body.id);
  });
});

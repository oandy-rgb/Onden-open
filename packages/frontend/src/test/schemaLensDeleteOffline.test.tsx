import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { getAppState, resetAppState } from "../lib/appStore";

// Offline-parity: deleting a tag while the server is unreachable must route
// through the offline-capable node delete (onDeleteNode → queued deleteNode),
// NOT a raw DELETE that hard-fails. The "Delete tag" button used to be
// disabled offline and the impact-preview fetch blocked the confirm entirely;
// now the confirm opens degraded (impact unknown) and the delete queues.

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    // Every server call fails offline — including the delete-preview the confirm
    // used to require. The degraded confirm must still open.
    api: vi.fn(async () => { throw new TypeError("Failed to fetch"); }),
    fetchTagMergePreview: vi.fn(),
    mergeTag: vi.fn(),
  };
});
vi.mock("../lib/localDb", () => ({
  addPendingWrite: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
}));

import SchemaLens from "../components/tagPage";
import type { Tag } from "../lib/api";

/** Rare tag actions (export, merge, delete) live in the title's ⋯ menu. */
async function tagAction(name: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: "Tag actions" }));
  return screen.getByRole("menuitem", { name });
}


const TAG: Tag = { id: "00000000-0000-4000-8000-00000000000a", name: "book", color: "", schema_id: null };

beforeEach(() => { resetAppState(); vi.clearAllMocks(); });

describe("SchemaLens offline delete (offline parity)", () => {
  it("opens a degraded confirm offline and routes the delete through onDeleteNode", async () => {
    const onDeleteNode = vi.fn(async () => true);
    render(<SchemaLens tag={TAG} online={false} onSaved={vi.fn()} allTags={[TAG]} onDeleteNode={onDeleteNode} />);

    // The outer "Delete tag" button is NOT disabled offline.
    const openBtn = await tagAction(/Delete tag/i);
    expect(openBtn).not.toBeDisabled();
    fireEvent.click(openBtn);

    // The impact report can't load offline → the confirm opens degraded, honest.
    await screen.findByText(/impact report isn't available/i);

    // Confirm → the delete is handed to the queued node delete, with the tag id.
    // Wait for the button itself: the text is in the DOM a moment before the
    // Modal's effect opens the <dialog> and makes its buttons accessible.
    fireEvent.click(await screen.findByRole("button", { name: /Delete #book/i }));
    await waitFor(() => expect(onDeleteNode).toHaveBeenCalledWith(TAG.id, "book"));
  });

  it("a refused delete keeps the confirm open and announces no success", async () => {
    const onSaved = vi.fn();
    const onDeleteNode = vi.fn(async () => false);
    render(<SchemaLens tag={TAG} online={false} onSaved={onSaved} allTags={[TAG]} onDeleteNode={onDeleteNode} />);
    fireEvent.click(await tagAction(/Delete tag/i));
    const confirm = await screen.findByRole("button", { name: /Delete #book/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(onDeleteNode).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: /Delete #book/i })).not.toBeDisabled());
    expect(onSaved).not.toHaveBeenCalled();
    expect(getAppState().toasts.some((toast) => /Deleted #book/.test(toast.message))).toBe(false);
  });

  it("an accepted delete leaves the announcement to the handler (no second toast)", async () => {
    const onSaved = vi.fn();
    render(<SchemaLens tag={TAG} online={false} onSaved={onSaved} allTags={[TAG]} onDeleteNode={vi.fn(async () => true)} />);
    fireEvent.click(await tagAction(/Delete tag/i));
    fireEvent.click(await screen.findByRole("button", { name: /Delete #book/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(getAppState().toasts.some((toast) => /Deleted #book/.test(toast.message))).toBe(false);
  });

  it("without onDeleteNode wired, the confirm still opens (fallback path exists)", async () => {
    render(<SchemaLens tag={TAG} online={false} onSaved={vi.fn()} allTags={[TAG]} />);
    fireEvent.click(await tagAction(/Delete tag/i));
    await screen.findByRole("button", { name: /Delete #book/i });
  });
});

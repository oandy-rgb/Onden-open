import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { resetAppState } from "../lib/appStore";

// Offline-parity: editing a tag's schema while the server is unreachable must
// QUEUE the PATCH (sendOrQueue), not be blocked. The editor inputs used to be
// disabled offline and the debounced save early-returned on !online.

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (typeof path === "string" && path.includes("/schema")) throw new TypeError("Failed to fetch"); // offline
      if (typeof path === "string" && path.endsWith("/delete-preview")) {
        return { members: 0, sample_titles: [], fields: [], views: 0, has_behaviour: false, reversible: true };
      }
      if (path === "/api/tags") return [];
      return {};
    }),
    fetchTagMergePreview: vi.fn(),
    mergeTag: vi.fn(),
  };
});
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
}));

import SchemaLens from "../components/tagPage";
import { addPendingWrite } from "../lib/localDb";
import { api } from "../lib/api";
import type { Tag } from "../lib/api";

const TAG: Tag = { id: "00000000-0000-4000-8000-00000000000a", name: "book", color: "", schema_id: null };

beforeEach(() => { resetAppState(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("SchemaLens offline schema edit (offline parity)", () => {
  it("adding a field while offline queues the schema PATCH", async () => {
    render(<SchemaLens tag={TAG} online={false} onSaved={vi.fn()} allTags={[TAG]} canManage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // flush mount fetches

    // Add a field and name it — the form is NOT disabled offline; 「確定」 fires the save.
    fireEvent.click(screen.getByRole("button", { name: /Add field/i }));
    const form = within(screen.getByRole("dialog", { name: "Add field" }));
    fireEvent.change(form.getByPlaceholderText(/Field name/), { target: { value: "Pages" } });
    fireEvent.click(form.getByRole("button", { name: "OK" }));
    // Past the 600ms debounce → sendOrQueue queues the PATCH offline.
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });

    const call = vi.mocked(addPendingWrite).mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes(`/api/tags/${TAG.id}/schema`),
    );
    expect(call, "the offline schema edit was queued").toBeTruthy();
    expect(String(call![0])).toBe("PATCH");
  });

  it("opens offline from the cached catalog row: its fields show and no settings read is attempted", async () => {
    const withField: Tag = { ...TAG, schema_id: "s1", schema_fields: [{ name: "author", type: "text" }] as Tag["schema_fields"] };
    render(<SchemaLens tag={withField} online={false} onSaved={vi.fn()} allTags={[withField]} canManage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.mocked(api).mock.calls.some(([path]) => path === "/api/tags")).toBe(false);
    expect(screen.getByRole("button", { name: /author$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load this tag's settings/)).toBeNull();
  });
});

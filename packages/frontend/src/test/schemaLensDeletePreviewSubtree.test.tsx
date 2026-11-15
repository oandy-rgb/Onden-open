import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { resetAppState } from "../lib/appStore";

// T7: deleting a tag trashes its live subtree (child tags, notes filed under
// it), so the confirm has to say so — it used to describe the tag alone.

const PREVIEW = {
  members: 0, sample_titles: [], fields: [], views: 0, has_behaviour: false, reversible: true,
  sub_tags: [{ id: "c1", name: "fiction" }, { id: "c2", name: "poetry" }],
  sub_tag_members: 4,
  descendant_items: 1,
  hidden_descendants: 2,
};

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path.endsWith("/delete-preview")) return PREVIEW;
      return {};
    }),
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


const TAG: Tag = { id: "00000000-0000-4000-8000-00000000000b", name: "book", color: "", schema_id: null };

beforeEach(() => { resetAppState(); vi.clearAllMocks(); });

describe("SchemaLens delete confirm lists the subtree (T7)", () => {
  it("names the sub-tags and counts what else is deleted", async () => {
    render(<SchemaLens tag={TAG} online onSaved={vi.fn()} allTags={[TAG]} onDeleteNode={vi.fn(async () => true)} />);
    fireEvent.click(await tagAction(/Delete tag/i));
    expect(await screen.findByText(/2 sub-tag\(s\) are deleted with it/)).toBeInTheDocument();
    expect(screen.getByText(/#fiction · #poetry/)).toBeInTheDocument();
    expect(screen.getByText(/4 note\(s\) lose a sub-tag/)).toHaveTextContent("(the notes stay)");
    expect(screen.getByText(/1 item\(s\) filed under it are deleted too/)).toBeInTheDocument();
    expect(screen.getByText(/2 more item\(s\) you can't open are deleted too/)).toBeInTheDocument();
  });
});

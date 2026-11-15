import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { resetAppState } from "../lib/appStore";

// Two tags may share a name under different parents (#draft, #proj/draft).
// The tag page heading and the merge menu show the path so they can be told
// apart (found in the #222 browser check: both pages were headed "#draft").

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path.endsWith("/delete-preview")) return { members: 0, sample_titles: [], fields: [], views: 0, has_behaviour: false, reversible: true };
      if (path === "/api/tags") return [];
      return {};
    }),
    fetchTagMergePreview: vi.fn(),
  };
});

import SchemaLens from "../components/tagPage";
import type { Tag } from "../lib/api";

/** Rare tag actions (export, merge, delete) live in the title's ⋯ menu. */
function tagAction(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
  return screen.getByRole("menuitem", { name });
}


const PROJ: Tag = { id: "00000000-0000-4000-8000-0000000000a1", name: "proj", color: "", schema_id: null };
const DRAFT: Tag = { id: "00000000-0000-4000-8000-0000000000a2", name: "draft", color: "", schema_id: null };
const PROJ_DRAFT: Tag = { id: "00000000-0000-4000-8000-0000000000a3", name: "draft", color: "", schema_id: null, parent_id: PROJ.id } as Tag;
const ALL = [PROJ, DRAFT, PROJ_DRAFT];

beforeEach(() => { resetAppState(); vi.clearAllMocks(); });

describe("tag path labels for same-name tags", () => {
  it("the child's heading shows its parent path; the root's does not", () => {
    const { unmount } = render(<SchemaLens tag={PROJ_DRAFT} online onSaved={vi.fn()} allTags={ALL} canManage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("#proj/draft");
    unmount();
    render(<SchemaLens tag={DRAFT} online onSaved={vi.fn()} allTags={ALL} canManage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^#draft$/);
  });

  it("a child tag's parent is in the breadcrumb, not a separate 上層 line", () => {
    const onOpenNode = vi.fn();
    render(<SchemaLens tag={PROJ_DRAFT} online onSaved={vi.fn()} allTags={ALL} onOpenNode={onOpenNode} />);
    expect(screen.queryByText("Parent", { exact: false })).toBeNull();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "proj" }));
    expect(onOpenNode).toHaveBeenCalledWith(PROJ.id);
  });

  it("the breadcrumb goes 全部標籤 › parent › tag; 全部標籤 opens the Tags page", () => {
    const onOpenNode = vi.fn();
    const onOpenTagsOverview = vi.fn();
    render(<SchemaLens tag={PROJ_DRAFT} online onSaved={vi.fn()} allTags={ALL} onOpenNode={onOpenNode} onOpenTagsOverview={onOpenTagsOverview} />);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("All tags › proj › draft");
    fireEvent.click(within(crumbs).getByRole("button", { name: "proj" }));
    expect(onOpenNode).toHaveBeenCalledWith(PROJ.id);
    fireEvent.click(within(crumbs).getByRole("button", { name: "All tags" }));
    expect(onOpenTagsOverview).toHaveBeenCalled();
    // The tag tree lives in the sidebar; the page no longer carries a copy.
    expect(screen.queryByRole("complementary", { name: "All tags" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Tag tree" })).toBeNull();
  });

  it("the merge menu names each candidate by its path", () => {
    render(<SchemaLens tag={DRAFT} online onSaved={vi.fn()} allTags={ALL} />);
    fireEvent.click(tagAction(/Merge into…/));
    const options = Array.from(screen.getByRole("combobox").querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("#proj/draft");
    expect(options).toContain("#proj");
  });
});

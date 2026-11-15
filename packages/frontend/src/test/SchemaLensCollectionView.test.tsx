import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SchemaLens from "../components/tagPage";
import CollectionView from "../components/collections/CollectionView";
import { api, type ContentNode, type Tag } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";

// The feature: the saved-views database surface (CollectionView) was built but
// ORPHANED — not mounted anywhere, so its 5 layouts were unreachable. SchemaLens
// (the tag-focused lens) now mounts it in place of the old static "Tagged notes"
// table. This test proves reachability: opening a class_tag with members renders
// the CollectionView with its layout switcher and the saved view's rows.
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (typeof path !== "string") return {};
      if (path.endsWith("/delete-preview")) {
        return { members: 0, sample_titles: [], fields: [], views: 0, has_behaviour: false, reversible: true };
      }
      // Tag detail bootstrap (policy/behaviour/fields).
      if (path === "/api/tags") return [{ id: TAG.id, schema_fields: [{ name: "status", type: "select" }], schema_behaviour: {} }];
      // CollectionView: list of saved views for the tag.
      if (path === `/api/tags/${TAG.id}/views`) {
        return { views: [{ id: "view-1", tag_id: TAG.id, name: "Board", layout: "kanban", filters: [], sorts: [], group_by: "status", visible_fields: ["title", "status"], layout_config: {}, pin_order: 0 }] };
      }
      // CollectionView: exec the active view.
      if (path === `/api/tags/${TAG.id}/views/view-1/exec`) {
        return {
          rows: [{ id: "n1", title: "First task", slug: "n1", updated_at: "2026-01-01T00:00:00Z", attributes: { status: "todo" } }],
          total: 1, next: null,
          view: { layout: "kanban", group_by: "status", visible_fields: ["title", "status"], layout_config: {} },
        };
      }
      return {};
    }),
  };
});

const TAG: Tag = { id: "00000000-0000-4000-8000-0000000000c1", name: "task", color: "", schema_id: "s1" };

// One node carrying #task so the section renders the database (not the empty state).
const NODE = {
  id: "n1", title: "First task", slug: "n1", node_type: "content",
  class_tag_ids: [TAG.id], hidden: false, attrs: { status: "todo" },
} as unknown as ContentNode;

describe("a tag page and its saved views", () => {
  beforeEach(() => { resetAppState(); resetOwnerViews(); localStorage.clear(); });

  it("the tag page lists the members; its saved views are tabs above the page, not a menu in it", async () => {
    render(<SchemaLens tag={TAG} online nodes={[NODE]} canManage />);
    await waitFor(() => expect(screen.getByText("First task")).toBeInTheDocument());
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "View options" })).toBeNull();
    expect(screen.queryByTitle(/Create a new view/)).toBeNull();
  });

  it("compares members field by field without a saved view", async () => {
    // A synthesis matrix for a fielded tag (e.g. #paper-review) needs no
    // view to be created first; it reads the members already loaded.
    render(<SchemaLens tag={{ ...TAG, schema_fields: [{ name: "status", type: "select", label: "Status" }] } as Tag} online nodes={[NODE]} />);
    const table = await screen.findByRole("table");
    expect(table).toHaveTextContent(/status/i);
    expect(table).toHaveTextContent("First task");
    expect(table).toHaveTextContent("todo");
    expect(screen.queryByText(/No views yet/)).toBeNull();
  });
});

describe("the pane of a saved-view tab", () => {
  beforeEach(() => { resetAppState(); resetOwnerViews(); localStorage.clear(); });
  const source = { kind: "tag" as const, id: TAG.id, name: "task" };

  it("runs the view through its layout, and the board offers its column field and the layouts", async () => {
    render(<CollectionView source={source} viewId="view-1" canManage />);
    expect(await screen.findByText("First task")).toBeInTheDocument();
    expect(screen.getByLabelText("Group by")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    const menu = await screen.findByRole("menu", { name: "View options" });
    expect(within(menu).getByRole("menuitemradio", { name: "Board" })).toBeChecked();
    expect(within(menu).getByRole("menuitemradio", { name: "Cards" })).toBeInTheDocument();
  });

  it("hides what changes the view from someone who may not manage it", async () => {
    render(<CollectionView source={source} viewId="view-1" canManage={false} />);
    await screen.findByText("First task");
    expect(screen.queryByRole("button", { name: "View options" })).toBeNull();
  });

  it("a board shows although no view module is imported, and every layout is offered", async () => {
    setAppState((st) => ({ data: { ...st.data, workspace: { ...st.data.workspace, modules: ["canvas"] } } }));
    render(<CollectionView source={source} viewId="view-1" canManage />);
    expect(await screen.findByText("First task", { selector: ".cv-kanban *" })).toBeInTheDocument();
    expect(screen.queryByText(/is off/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    const menu = await screen.findByRole("menu", { name: "View options" });
    for (const name of ["Table", "Board", "Calendar", "Cards"]) expect(within(menu).getByRole("menuitemradio", { name })).toBeInTheDocument();
  });

  it("a view stored with the removed list layout shows as a table", async () => {
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((async (path: string) => {
      if (path === `/api/tags/${TAG.id}/views`) {
        return { views: [{ id: "view-l", tag_id: TAG.id, name: "Old list", layout: "list", filters: [], sorts: [], group_by: null, visible_fields: ["title"], layout_config: {}, pin_order: 0 }] };
      }
      if (path === `/api/tags/${TAG.id}/views/view-l/exec`) {
        return { rows: [{ id: "n1", title: "First task", slug: "n1", updated_at: "2026-01-01T00:00:00Z", attributes: {} }], count: 1,
          view: { layout: "list", group_by: null, visible_fields: ["title"], layout_config: {} } };
      }
      return {};
    }) as never);
    render(<CollectionView source={source} viewId="view-l" canManage />);
    expect(await screen.findByRole("table")).toHaveTextContent("First task");
    vi.mocked(api).mockImplementation(original);
  });

  it("says the view is gone when its id is not among the owner's views", async () => {
    render(<CollectionView source={source} viewId="deleted-view" canManage />);
    expect(await screen.findByText(/This view is gone/)).toBeInTheDocument();
  });
});

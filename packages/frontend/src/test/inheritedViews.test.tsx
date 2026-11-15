// Inherited views (views-as-modules.md rule 5, V4): a child tag shows its
// parent's views after its own (tabs marked 「經由 #書」), read only — no options menu,
// layout switch or filters — with 「複製成自己的」 making an editable copy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CollectionView from "../components/collections/CollectionView";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

const created: unknown[][] = [];
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, viewWriter: { ...actual.viewWriter, create: vi.fn(async (...args: unknown[]) => { created.push(args); return "copy"; }) } };
});

const TAG = "00000000-0000-4000-8000-0000000000f1";
const BOOK = "00000000-0000-4000-8000-0000000000f2";
const shelf = { id: "shelf", tag_id: BOOK, name: "Shelf", layout: "kanban", filters: [], sorts: [], group_by: "status",
  visible_fields: ["title", "status"], layout_config: {}, pin_order: 0, inherited_from: BOOK, inherited_name: "書" };

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path === `/api/tags/${TAG}/views`) return { views: [shelf] };
      if (path === `/api/tags/${TAG}/views/shelf/exec`) {
        return { rows: [{ id: "n1", title: "Dune", slug: "n1", updated_at: "2026-10-01T00:00:00Z", attributes: { status: "done" } }],
          count: 1, view: { layout: "kanban", group_by: "status", visible_fields: shelf.visible_fields, layout_config: {} } };
      }
      return {};
    }),
  };
});

describe("inherited views", () => {
  beforeEach(() => {
    resetAppState();
    setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules: null } } }));
    resetOwnerViews();
    created.length = 0;
  });

  it("is marked with its tag, read only, and copies as the tag's own", async () => {
    render(<CollectionView source={{ kind: "tag", id: TAG, name: "小說" }} viewId="shelf" canManage />);
    await screen.findByText("Dune");
    expect(screen.getByText(/From #書 — change it there/)).toBeInTheDocument();
    // Read only: no options menu at all (layout, filters and rename are changed on the tag).
    expect(screen.queryByRole("button", { name: "View options" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy as this tag's own" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual([{ kind: "tag", id: TAG }, expect.objectContaining({ name: "Shelf", layout: "kanban", group_by: "status", visible_fields: ["title", "status"] })]);
  });
});

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// D66: a saved table view of a 350-note tag showed the first 200 rows, summed
// the price column over those 200 and said nothing about the other 150. The
// view now pages: the table says "200 of 350 rows", holds its totals until
// every row is loaded, and Load more brings the next page.

const TAG_ID = "00000000-0000-4000-8000-0000000000d6";
const calls: string[] = [];

function rows(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${from + i}`, title: `Note ${from + i}`, slug: `n${from + i}`,
    updated_at: "2026-01-01T00:00:00Z", attributes: { price: "1" },
  }));
}
const VIEW = { layout: "table", group_by: null, visible_fields: ["title", "price"], layout_config: { aggregates: true }, field_meta: { price: { type: "number" } } };

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      calls.push(path);
      if (path === `/api/tags/${TAG_ID}/views`) {
        return { views: [{ id: "v1", tag_id: TAG_ID, name: "All", layout: "table", filters: [], sorts: [], group_by: null, visible_fields: ["title", "price"], layout_config: {}, pin_order: 0 }] };
      }
      if (path === `/api/tags/${TAG_ID}/views/v1/exec`) return { rows: rows(0, 200), total: 350, next: 200, view: VIEW };
      if (path === `/api/tags/${TAG_ID}/views/v1/exec?offset=200`) return { rows: rows(200, 150), total: 350, next: null, view: VIEW };
      return {};
    }),
  };
});

import CollectionView from "../components/collections/CollectionView";
import { resetAppState, setAppState } from "../lib/appStore";

describe("CollectionView paging (D66)", () => {
  it("shows the real total, holds the Σ over a partial load, and loads the rest", async () => {
    render(<CollectionView source={{ kind: "tag", id: TAG_ID, name: "book" }} viewId="v1" />);
    const foot = () => Array.from(document.querySelectorAll(".cv-table-foot")).map((td) => td.textContent);

    await waitFor(() => expect(foot()[0]).toBe("200 of 350 rows"));
    expect(foot()[1]).toBe(""); // no Σ over 200 of 350
    expect(screen.getByText("200 of 350 rows", { selector: ".cv-more-count" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(foot()[0]).toBe("350 rows"));
    expect(foot()[1]).toBe("Σ 350 · avg 1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(calls).toContain(`/api/tags/${TAG_ID}/views/v1/exec?offset=200`);
  });
});

describe("a saved view in a workspace that imported no view module", () => {
  it("still shows its table: view modules are always on", async () => {
    resetAppState();
    setAppState((state) => ({ data: { ...state.data, workspace: { ...state.data.workspace, modules: [] } } }));
    render(<CollectionView source={{ kind: "tag", id: TAG_ID, name: "book" }} viewId="v1" />);
    await waitFor(() => expect(screen.getByText("200 of 350 rows", { selector: ".cv-more-count" })).toBeTruthy());
    expect(document.querySelector(".cv-module-missing")).toBeNull();
    resetAppState();
  });
});

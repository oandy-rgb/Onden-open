import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 閱讀 › RSS groups feeds like folders, by the first tag of each feed's save
// default; feeds without one go last.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});

import RssReaderPanel from "./RssReaderPanel";
import { groupSources } from "./groupSources";
import { noWorkspaceData, type Tag } from "../../lib/api";
import { resetAppState } from "../../lib/appStore";
import type { RssSource } from "./useRssUnread";

const tag = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id, color: "", schema_id: null }) as Tag;
const TAGS = [tag("t-news", "新聞"), tag("t-tech", "科技", "t-news"), tag("t-blog", "部落格")];
const src = (id: string, title: string, tagIds: string[]): RssSource => ({
  id, title, url: `https://example.com/${id}.xml`, fetch_interval_minutes: 60, last_fetched_at: null, last_error: null,
  auto_tag: null, embed: false, unseen: 0, created_at: "2026-10-01T00:00:00Z",
  save_default: { tag_ids: tagIds, parent_id: null, parent_title: null, origin: tagIds.length ? "source" : "none" },
});
const SOURCES = [
  src("a", "Alpha", []), src("b", "Bravo", ["t-tech", "t-blog"]), src("c", "Charlie", ["t-blog"]),
  src("d", "Delta", ["t-tech"]), src("e", "Echo", ["t-gone"]),
];

describe("groupSources", () => {
  it("groups by the default's first tag, by path, ungrouped last", () => {
    const groups = groupSources(SOURCES, TAGS);
    const byLabel = new Map(groups.map((g) => [g.label, g.sources.map((s) => s.id)]));
    expect(byLabel.get("新聞/科技")).toEqual(["b", "d"]);
    expect(byLabel.get("部落格")).toEqual(["c"]);
    expect(groups.at(-1)!.sources.map((s) => s.id)).toEqual(["a", "e"]); // no tag, or a tag that is gone
    const labels = groups.slice(0, -1).map((g) => g.label);
    expect(labels).toEqual([...labels].sort((x, y) => x.localeCompare(y)));
    expect(groups.at(-1)!.tagId).toBeNull();
  });

  it("no group at all when nothing has a tag", () => {
    expect(groupSources([src("a", "Alpha", [])], TAGS)).toEqual([{ tagId: null, label: "", sources: [expect.objectContaining({ id: "a" })] }]);
  });
});

describe("the feed list", () => {
  beforeEach(() => {
    resetAppState({ data: { ...noWorkspaceData, tags: TAGS }, online: true });
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/rss/sources")) return { sources: SOURCES, total_unseen: 0, module_default: null };
      if (path.startsWith("/api/rss/items")) return { items: [], next_cursor: null };
      return {};
    });
  });

  it("shows a heading per folder and puts the ungrouped feeds last", async () => {
    render(<RssReaderPanel online onOpenNode={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Manage feeds" }));
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findByText("Alpha");
    const groups = within(sheet).getAllByRole("group").filter((g) => g.classList.contains("rss-source-group"));
    const labels = groups.map((g) => g.getAttribute("aria-label"));
    expect(new Set(labels)).toEqual(new Set(["#新聞/科技", "#部落格", "Other feeds"]));
    expect(labels.at(-1)).toBe("Other feeds");
    const tech = groups.find((g) => g.getAttribute("aria-label") === "#新聞/科技")!;
    expect(within(tech).getAllByText(/Bravo|Delta/).map((n) => n.textContent)).toEqual(["Bravo", "Delta"]);
    expect(within(groups.at(-1)!).getByText("Alpha")).toBeInTheDocument();
    expect(within(groups.at(-1)!).getByText("Echo")).toBeInTheDocument();
  });
});

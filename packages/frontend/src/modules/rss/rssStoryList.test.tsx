import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RssItemList, { type RssListItem } from "./RssItemList";

// The same story from two feeds is one row with 「另有 N 個來源」; opening it lists the others.

const row = (id: string, title: string, source_id: string, hoursAgo: number): RssListItem => {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return { id, title, source_id, published_at: at, fetched_at: at, seen: false };
};
const names: Record<string, string> = { s1: "Daily News", s2: "Tech Blog", s3: "Weather" };

function list(items: RssListItem[], onOpen = vi.fn()) {
  render(<RssItemList items={items} today="2000-01-01" lastReadId={null} activeId={null} singleSource={false}
    sourceTitle={(id) => names[id] ?? ""} hasNewer={false} nextCursor={null} loadingMore={false}
    onOpen={onOpen} onLoadMore={() => {}} onShowNewer={() => {}} />);
  return onOpen;
}

describe("the same story from several feeds", () => {
  const items = [
    row("a", "Apple unveils the new iPhone 17 lineup", "s1", 1),
    row("w", "Heavy rain expected across the island this weekend", "s3", 2),
    row("b", "Apple unveils new iPhone 17 lineup - The Verge", "s2", 3),
  ];

  it("is one row, with the other source behind a button", async () => {
    list(items);
    expect(screen.getAllByRole("button", { name: /Apple unveils/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "1 more source" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the others under it, and each opens its own article", async () => {
    const onOpen = list(items);
    await userEvent.click(screen.getByRole("button", { name: "1 more source" }));
    const story = screen.getByRole("button", { name: "1 more source" }).closest(".rss-story") as HTMLElement;
    await userEvent.click(within(story).getByRole("button", { name: /The Verge/ }));
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("leaves different stories as they are", () => {
    list([items[0]!, items[1]!]);
    expect(screen.queryByRole("button", { name: /more source/ })).toBeNull();
  });
});

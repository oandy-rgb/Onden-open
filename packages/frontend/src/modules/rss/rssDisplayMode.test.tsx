import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RssItemList, { type RssListItem } from "./RssItemList";
import type { RssDisplayMode } from "./useRssUnread";

// 顯示方式: text as ever, 圖片優先 a large picture card, 影音 a play control in the list.

const base = { published_at: "2026-11-02T00:00:00Z", fetched_at: "2026-11-02T00:00:00Z", seen: false };
const items: RssListItem[] = [
  { ...base, id: "t", title: "A text article", source_id: "text", excerpt: "summary words", image: "https://x.test/t.png" },
  { ...base, id: "i", title: "A comic page", source_id: "image", excerpt: "summary words", image: "https://x.test/i.png" },
  { ...base, id: "v", title: "A clip", source_id: "video", media: { kind: "video", url: "https://x.test/v.mp4" } },
  { ...base, id: "e", title: "A YouTube talk", source_id: "video", media: { kind: "embed", url: "https://www.youtube.com/watch?v=abc" } },
  { ...base, id: "n", title: "A video feed article with nothing to play", source_id: "video" },
];
const modes: Record<string, RssDisplayMode> = { text: "text", image: "image", video: "video" };

function list(onOpen = vi.fn()) {
  const view = render(<RssItemList items={items} today="2026-11-02" lastReadId={null} activeId={null} singleSource={false}
    sourceTitle={(id) => id} displayModeOf={(id) => modes[id] ?? "text"} hasNewer={false} nextCursor={null} loadingMore={false}
    onOpen={onOpen} onLoadMore={() => {}} onShowNewer={() => {}} />);
  return { onOpen, view };
}
const row = (id: string) => document.querySelector(`.rss-item[data-item-id="${id}"]`) as HTMLElement;

describe("display mode", () => {
  it("text keeps the summary and a small thumbnail", () => {
    list();
    expect(row("t").querySelector(".rss-item-excerpt")).not.toBeNull();
    expect(row("t").querySelector(".rss-item-thumb")).not.toBeNull();
    expect(row("t").querySelector(".rss-item-cover")).toBeNull();
  });

  it("pictures first shows the picture large, in place of the thumbnail and summary", () => {
    list();
    expect(row("i").querySelector(".rss-item-cover")).not.toBeNull();
    expect(row("i").querySelector(".rss-item-thumb")).toBeNull();
    expect(row("i").querySelector(".rss-item-excerpt")).toBeNull();
    expect(row("i")).toHaveClass("rss-item--image");
  });

  it("video: a file plays in the list when asked, and not before", async () => {
    const { onOpen } = list();
    expect(document.querySelector("video")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Play A clip" }));
    const player = document.querySelector("video") as HTMLVideoElement;
    expect(player.getAttribute("src")).toBe("https://x.test/v.mp4");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("video: a player link opens the article, which shows the player", async () => {
    const { onOpen } = list();
    await userEvent.click(screen.getByRole("button", { name: "Play A YouTube talk" }));
    expect(onOpen).toHaveBeenCalledWith("e");
  });

  it("video: an article with nothing to play has no play button; the other modes never do", () => {
    list();
    expect(screen.queryByRole("button", { name: /Play A video feed article/ })).toBeNull();
    expect(within(row("t").parentElement!).queryByRole("button", { name: /Play/ })).toBeNull();
  });
});

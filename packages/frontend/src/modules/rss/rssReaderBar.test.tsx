import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The reader's one verb and its reading flow:
//   * 存成筆記 (the whole article) is a quiet control at the end, after
//     寫點什麼 (no bottom bar, nothing beside the title); tapping it saves at
//     the feed's default (tooltip / caption; no sheet, no destination sent);
//     ▾ opens the sheet;
//   * an article becomes seen when it is LEFT — the next card, a swipe, back
//     to the list — not when it opens;
//   * 上一篇 / 下一篇 sit side by side at the end (an empty slot holds a
//     missing one); swipe left = next, swipe right = previous;
//   * full text loads by itself for a summary-only item (or a feed set to
//     總是載入全文); the 載入全文 link stays only when that failed or did not run.

const { apiMock, sendWriteMock, sendOrQueueMock } = vi.hoisted(() => ({
  apiMock: vi.fn(), sendWriteMock: vi.fn(), sendOrQueueMock: vi.fn(),
}));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/data", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/data")>();
  return { ...mod, sendOrQueue: sendOrQueueMock };
});
vi.mock("../../lib/data/onlineWrite", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/data/onlineWrite")>()), sendWrite: sendWriteMock }));
vi.mock("../../hooks/useIsMobile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../hooks/useIsMobile")>();
  return { ...mod, isMobileLayout: () => true };
});

import { forgetRssPrefs } from "./rssPrefs";
import RssReaderPanel from "./RssReaderPanel";
import { noWorkspaceData, type Tag } from "../../lib/api";
import { resetAppState } from "../../lib/appStore";

const LONG = `<p>${"A full paragraph of the article. ".repeat(40)}</p>`;
const SHORT = "<p>Only a short description…</p>";
const FULL = "<p>THE WHOLE ARTICLE</p>";

const tag = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id, color: "", schema_id: null }) as Tag;
const source = (always = false) => ({
  id: "s1", title: "Daily News", url: "https://example.com/feed.xml", fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 3, created_at: "2026-10-01T00:00:00Z", always_fulltext: always,
  save_default: { tag_ids: ["t-tech"], parent_id: null, parent_title: null, origin: "source" },
});
const row = (id: string, title: string) => ({
  id, title, source_id: "s1", url: `https://example.com/${id}`, published_at: "2026-10-17T00:00:00Z",
  fetched_at: "2026-10-17T00:00:00Z", seen: false, saved_node_id: null, excerpt: "", image: null,
});
const ROWS = [row("i1", "First story"), row("i2", "Second story"), row("i3", "Third story")];
let bodies: Record<string, string> = {};
let feed = source();

beforeEach(() => {
  forgetRssPrefs();
  bodies = { i1: LONG, i2: LONG, i3: LONG };
  feed = source();
  resetAppState({ data: { ...noWorkspaceData, tags: [tag("t-news", "新聞"), tag("t-tech", "科技", "t-news")] }, online: true });
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources: [feed], total_unseen: 3, module_default: null };
    const one = /^\/api\/rss\/items\/(i\d)$/.exec(path);
    if (one) return { ...ROWS.find((r) => r.id === one[1])!, body: bodies[one[1]!] };
    if (path.startsWith("/api/rss/items")) return { items: ROWS, next_cursor: null };
    return {};
  });
  sendWriteMock.mockReset();
  sendWriteMock.mockImplementation(async (_m: string, path: string) => (path.endsWith("/fulltext") ? { body: FULL } : {}));
  sendOrQueueMock.mockReset();
  sendOrQueueMock.mockImplementation(async (_m: string, _p: string, body: string) => ({ node_id: JSON.parse(body).node_id }));
});

const seenCalls = () => sendWriteMock.mock.calls.filter((c) => String(c[1]).endsWith("/seen")).map((c) => String(c[1]));
const fulltextCalls = () => sendWriteMock.mock.calls.filter((c) => String(c[1]).endsWith("/fulltext"));

async function open(title: RegExp) {
  render(<RssReaderPanel online onOpenNode={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: title }));
  await screen.findByRole("heading", { name: title });
}

// Keeping the whole article is the secondary action at the end (after
// 寫點什麼); nothing sits beside the title.
const endSave = () => document.querySelector<HTMLElement>(".rss-article-end .rss-save-ctl")!;

describe("RSS reader: saving the whole article", () => {
  it("only at the end: one tap saves at the default, then reads Saved", async () => {
    await open(/First story/);
    expect(document.querySelector(".rss-article-head .rss-save-ctl")).toBeNull();
    expect(document.querySelector(".rss-article-actions")).toBeNull();
    const save = within(endSave()).getByRole("button", { name: /Save to notes/ });
    expect(save).toHaveAttribute("title", "Save to notes → #新聞/科技");
    expect(within(endSave()).getByText("→ #新聞/科技")).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(sendOrQueueMock).toHaveBeenCalled());
    const body = JSON.parse(String(sendOrQueueMock.mock.calls[0]![2]));
    expect(body.destination).toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Saved · open note/ })).toHaveLength(1));
    // Still on the one row with 寫點什麼, as a small button.
    const row = document.querySelector<HTMLElement>(".rss-article-end .rss-end-actions")!;
    expect(within(row).getByRole("button", { name: /Saved · open note/ }).className).toMatch(/ui-btn--sm/);
    expect(within(row).getByRole("button", { name: /Write something/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save to notes/ })).toBeNull();
  });

  it("a queued (offline) save reads Saved and opens the minted note", async () => {
    sendOrQueueMock.mockImplementation(async () => undefined); // queued on this device
    const onOpenNode = vi.fn();
    render(<RssReaderPanel online={false} onOpenNode={onOpenNode} />);
    await userEvent.click(await screen.findByRole("button", { name: /First story/ }));
    await screen.findByRole("heading", { name: /First story/ });
    await userEvent.click(within(endSave()).getByRole("button", { name: /Save to notes/ }));
    expect(await screen.findByText("Saved on this device — it will sync when the server is reachable.")).toBeInTheDocument();
    const minted = JSON.parse(String(sendOrQueueMock.mock.calls[0]![2])).node_id;
    await userEvent.click(within(endSave()).getByRole("button", { name: /Saved · open note/ }));
    expect(onOpenNode).toHaveBeenCalledWith(minted);
  });

  it("▾ at the end of the article opens the 「存到」 sheet", async () => {
    await open(/First story/);
    await userEvent.click(within(endSave()).getByRole("button", { name: "Choose where to save" }));
    expect(await screen.findByRole("dialog", { name: "Save to" })).toBeInTheDocument();
  });
});

describe("RSS reader: leaving marks seen", () => {
  it("opening does not mark seen; the next card does, for the article left", async () => {
    await open(/First story/);
    expect(seenCalls()).toEqual([]);
    const nav = screen.getByRole("navigation", { name: "Previous and next article" });
    // Side by side: an empty slot on the left of the first article, next on the right.
    expect(nav.children).toHaveLength(2);
    expect(nav.children[0]!.tagName).toBe("SPAN");
    await userEvent.click(within(nav).getByRole("button", { name: /Next article/ }));
    await screen.findByRole("heading", { name: /Second story/ });
    expect(seenCalls()).toEqual(["/api/rss/items/i1/seen"]);
    const nav2 = screen.getByRole("navigation", { name: "Previous and next article" });
    expect(within(nav2).getByRole("button", { name: /Previous article/ })).toHaveTextContent("First story");
    expect(within(nav2).getByRole("button", { name: /Next article/ })).toHaveTextContent("Third story");
  });

  it("swipe left opens the next article (marking the left one), swipe right goes back", async () => {
    await open(/First story/);
    const pane = document.querySelector(".rss-right")!;
    fireEvent.touchStart(pane, { touches: [{ clientX: 300, clientY: 400 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientX: 100, clientY: 410 }] });
    await screen.findByRole("heading", { name: /Second story/ });
    expect(seenCalls()).toEqual(["/api/rss/items/i1/seen"]);
    fireEvent.touchStart(pane, { touches: [{ clientX: 100, clientY: 400 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientX: 320, clientY: 405 }] });
    await screen.findByRole("heading", { name: /First story/ });
    expect(seenCalls()).toEqual(["/api/rss/items/i1/seen", "/api/rss/items/i2/seen"]);
  });

  it("back to the list marks the open article seen", async () => {
    await open(/First story/);
    await userEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(seenCalls()).toEqual(["/api/rss/items/i1/seen"]);
  });
});

describe("RSS reader: full text", () => {
  it("loads by itself for a summary-only item, with no fallback link", async () => {
    bodies.i1 = SHORT;
    await open(/First story/);
    await waitFor(() => expect(fulltextCalls()).toHaveLength(1));
    expect(await screen.findByText("THE WHOLE ARTICLE")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load full text" })).toBeNull();
  });

  it("keeps the 載入全文 link when the automatic load failed", async () => {
    bodies.i1 = SHORT;
    sendWriteMock.mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith("/fulltext")) throw new Error("page unavailable");
      return {};
    });
    await open(/First story/);
    const link = await screen.findByRole("button", { name: "Load full text" });
    expect(screen.getByText("Only a short description…")).toBeInTheDocument();
    sendWriteMock.mockImplementation(async (_m: string, path: string) => (path.endsWith("/fulltext") ? { body: FULL } : {}));
    await userEvent.click(link);
    expect(await screen.findByText("THE WHOLE ARTICLE")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load full text" })).toBeNull();
  });

  it("a complete article is not fetched again; the link stays as the fallback", async () => {
    await open(/First story/);
    expect(fulltextCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Load full text" })).toBeInTheDocument();
  });

  it("a feed set to 總是載入全文 loads even a long item", async () => {
    feed = source(true);
    render(<RssReaderPanel online onOpenNode={() => {}} />);
    // Wait for the feed list so the reader knows the feed's setting.
    await screen.findByRole("button", { name: "Daily News" });
    await userEvent.click(await screen.findByRole("button", { name: /First story/ }));
    await waitFor(() => expect(fulltextCalls()).toHaveLength(1));
    expect(await screen.findByText("THE WHOLE ARTICLE")).toBeInTheDocument();
  });
});

describe("RSS reader: a longer list than one page", () => {
  it("reading the last loaded article fetches the next page: 下一篇 is there, not 「都看完了」", async () => {
    const PAGE2 = [row("i4", "Fourth story")];
    bodies.i4 = LONG;
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/rss/sources")) return { sources: [feed], total_unseen: 4, module_default: null };
      const one = /^\/api\/rss\/items\/(i\d)$/.exec(path);
      if (one) return { ...[...ROWS, ...PAGE2].find((r) => r.id === one[1])!, body: bodies[one[1]!] };
      if (path.startsWith("/api/rss/items")) return path.includes("cursor=") ? { items: PAGE2, next_cursor: null } : { items: ROWS, next_cursor: "c2" };
      return {};
    });
    await open(/Third story/);
    const nav = screen.getByRole("navigation", { name: "Previous and next article" });
    expect(await within(nav).findByRole("button", { name: /Next article.*Fourth story/ })).toBeInTheDocument();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
  });

  it("「都看完了」 at the real end", async () => {
    await open(/Third story/);
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
  });
});

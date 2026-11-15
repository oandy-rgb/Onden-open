import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The reader keeps a reading position instead of a read/unread state:
//   * each view (All feeds, each feed) remembers the article you were on and
//     reopens on it; 「‹ 列表」 keeps the place but reopens on the list;
//   * a thin progress bar shows how far along the list you are (no 「1 / 20」);
//   * 「全部略過」 marks the view seen and its toast's 復原 undoes exactly that;
//   * a swipe changes article only when it is clearly horizontal — vertical
//     scrolling and text selection are never taken for one;
//   * 閱讀's mark is a dot for "arrived since the reader was last open".

const { apiMock, sendWriteMock } = vi.hoisted(() => ({ apiMock: vi.fn(), sendWriteMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/data", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/data")>();
  return { ...mod, sendWrite: sendWriteMock };
});

import { forgetRssPrefs } from "./rssPrefs";
import RssReaderPanel from "./RssReaderPanel";
import RssNavIndicator from "./RssNavIndicator";
import { swipeIntent, SWIPE_MIN_DX, readingPosition } from "./readingPosition";
import { hasNewSince } from "./useRssUnread";
import { bindAccountStorage } from "../../lib/accountStorage";
import { resetAppState } from "../../lib/appStore";
import { noWorkspaceData } from "../../lib/api";

bindAccountStorage("unit-test-account", "");

const row = (id: string, title: string, source_id = "s1") => ({
  id, title, source_id, url: `https://example.com/${id}`, published_at: "2026-10-17T00:00:00Z",
  fetched_at: "2026-10-17T00:00:00Z", seen: false, saved_node_id: null, excerpt: "", image: null,
});
const ROWS = [row("i1", "First story"), row("i2", "Second story"), row("i3", "Third story"), row("i4", "Fourth story")];
const feed = {
  id: "s1", title: "Daily News", url: "https://example.com/feed.xml", fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 4, created_at: "2026-10-01T00:00:00Z",
  latest_unseen_at: "2026-10-18T08:00:00.000Z",
};
let latest: string | null = "2026-10-18T08:00:00.000Z";

beforeEach(() => {
  localStorage.clear();
  forgetRssPrefs();
  latest = "2026-10-18T08:00:00.000Z";
  resetAppState({ data: { ...noWorkspaceData }, online: true });
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources: [feed], total_unseen: 4, latest_unseen_at: latest, module_default: null };
    const one = /^\/api\/rss\/items\/(i\d)$/.exec(path);
    if (one) return { ...ROWS.find((r) => r.id === one[1])!, body: `<p>${"Body text. ".repeat(80)}</p>` };
    if (path.startsWith("/api/rss/items")) return { items: ROWS, next_cursor: null };
    return {};
  });
  sendWriteMock.mockReset();
  sendWriteMock.mockImplementation(async () => ({}));
});

const reader = () => render(<RssReaderPanel online onOpenNode={() => {}} />);

describe("reading position", () => {
  it("reopening the reader resumes at the article you were on", async () => {
    const first = reader();
    await userEvent.click(await screen.findByRole("button", { name: /Third story/ }));
    await screen.findByRole("heading", { name: /Third story/ });
    expect(readingPosition("all")).toEqual({ id: "i3", open: true });
    first.unmount();

    reader();
    expect(await screen.findByRole("heading", { name: /Third story/ })).toBeInTheDocument();
  });

  it("each feed keeps its own place, apart from All feeds", async () => {
    const first = reader();
    await userEvent.click(await screen.findByRole("button", { name: /Second story/ }));
    await screen.findByRole("heading", { name: /Second story/ });
    // Into the feed: no place there yet, so its list.
    await userEvent.click(screen.getByRole("button", { name: "Daily News" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Second story/ })).toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: /Fourth story/ }));
    await screen.findByRole("heading", { name: /Fourth story/ });
    expect(readingPosition("s1")).toEqual({ id: "i4", open: true });
    // Back to All feeds: its own place.
    await userEvent.click(within(screen.getByRole("toolbar", { name: "Feeds" })).getByRole("button", { name: "All" }));
    expect(await screen.findByRole("heading", { name: /Second story/ })).toBeInTheDocument();
    first.unmount();
  });

  it("「‹ 列表」 keeps the place but reopens on the list", async () => {
    const first = reader();
    await userEvent.click(await screen.findByRole("button", { name: /Second story/ }));
    await screen.findByRole("heading", { name: /Second story/ });
    await userEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(readingPosition("all")).toEqual({ id: "i2", open: false });
    first.unmount();

    reader();
    await screen.findByRole("button", { name: /Second story/ });
    expect(screen.queryByRole("heading", { name: /Second story/ })).toBeNull();
  });

  it("a place that is gone (aged out) fails quietly", async () => {
    localStorage.clear();
    const first = reader();
    await userEvent.click(await screen.findByRole("button", { name: /First story/ }));
    await screen.findByRole("heading", { name: /First story/ });
    first.unmount();
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/rss/sources")) return { sources: [feed], total_unseen: 3, module_default: null };
      if (path === "/api/rss/items/i1") throw new Error("article aged out of the stream");
      if (path.startsWith("/api/rss/items")) return { items: ROWS.slice(1), next_cursor: null };
      return {};
    });
    reader();
    await screen.findByRole("button", { name: /Second story/ });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/rss/items/i1"));
    expect(screen.queryByText("article aged out of the stream")).toBeNull();
  });
});

describe("progress bar", () => {
  it("shows the place in the list as a bar, with no 「n / total」 counter", async () => {
    reader();
    await userEvent.click(await screen.findByRole("button", { name: /Second story/ }));
    await screen.findByRole("heading", { name: /Second story/ });
    const bar = screen.getByRole("progressbar", { name: "Place in the list" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect((bar.firstElementChild as HTMLElement).style.getPropertyValue("--rss-progress")).toBe("50%");
    expect(document.querySelector(".rss-article-count")).toBeNull();
    expect(screen.queryByText("2 / 4")).toBeNull();
  });
});

describe("the list is a stream, not a pile to clear", () => {
  it("has no 「全部｜未讀」 switch and no 「全部略過」", async () => {
    reader();
    await screen.findByRole("button", { name: /First story/ });
    expect(screen.queryByRole("button", { name: /Skip all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unseen" })).toBeNull();
    const url = apiMock.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith("/api/rss/items?"))!;
    expect(url).not.toContain("unseen");
  });

  it("cuts the list by day", async () => {
    reader();
    await screen.findByRole("button", { name: /First story/ });
    expect(document.querySelector(".rss-day")?.textContent).toBe("Earlier");
  });
});

describe("swipe between articles", () => {
  const at = (x: number, y: number, t = 0) => ({ x, y, t });

  it("only a clearly horizontal flick past the threshold counts", () => {
    expect(swipeIntent(at(300, 400), at(300 - SWIPE_MIN_DX - 1, 405, 200))).toBe("next");
    expect(swipeIntent(at(100, 400), at(100 + SWIPE_MIN_DX + 1, 395, 200))).toBe("prev");
    // Short of the threshold.
    expect(swipeIntent(at(300, 400), at(300 - SWIPE_MIN_DX + 5, 400, 200))).toBeNull();
    // Vertical scrolling with some sideways drift.
    expect(swipeIntent(at(300, 600), at(200, 300, 200))).toBeNull();
    // Diagonal: not more than twice as far across as down.
    expect(swipeIntent(at(300, 400), at(200, 350, 200))).toBeNull();
    // A slow drag (selecting, reading with a finger) is not a flick.
    expect(swipeIntent(at(300, 400), at(100, 400, 1200))).toBeNull();
    // A gesture that left a text selection is a selection.
    expect(swipeIntent(at(300, 400), at(100, 400, 200), { selecting: true })).toBeNull();
  });

  it("vertical scrolling in the article never changes it; a horizontal swipe does", async () => {
    reader();
    await userEvent.click(await screen.findByRole("button", { name: /First story/ }));
    await screen.findByRole("heading", { name: /First story/ });
    const pane = document.querySelector(".rss-right")!;
    fireEvent.touchStart(pane, { touches: [{ clientX: 300, clientY: 600 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientX: 220, clientY: 200 }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("heading", { name: /First story/ })).toBeInTheDocument();

    fireEvent.touchStart(pane, { touches: [{ clientX: 300, clientY: 400 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientX: 120, clientY: 410 }] });
    expect(await screen.findByRole("heading", { name: /Second story/ })).toBeInTheDocument();
    expect(document.querySelector(".rss-article-scroll")).toHaveAttribute("data-enter", "next");
  });

  it("a swipe while text is selected keeps the article", async () => {
    reader();
    await userEvent.click(await screen.findByRole("button", { name: /First story/ }));
    await screen.findByRole("heading", { name: /First story/ });
    const sel = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Body text." } as unknown as Selection);
    const pane = document.querySelector(".rss-right")!;
    fireEvent.touchStart(pane, { touches: [{ clientX: 300, clientY: 400 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientX: 100, clientY: 400 }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("heading", { name: /First story/ })).toBeInTheDocument();
    sel.mockRestore();
  });

  it("the end of an article offers 上一篇 and 下一篇 side by side", async () => {
    reader();
    await userEvent.click(await screen.findByRole("button", { name: /Second story/ }));
    await screen.findByRole("heading", { name: /Second story/ });
    const nav = screen.getByRole("navigation", { name: "Previous and next article" });
    expect(within(nav).getByRole("button", { name: /Previous article/ })).toHaveTextContent("First story");
    expect(within(nav).getByRole("button", { name: /Next article/ })).toHaveTextContent("Third story");
  });
});

describe("閱讀's dot", () => {
  it("means 'arrived since the reader was last open'", () => {
    expect(hasNewSince(null, null, 0)).toBe(false);
    expect(hasNewSince("2026-10-18T08:00:00Z", null, 3)).toBe(true);
    expect(hasNewSince("2026-10-18T08:00:00Z", "2026-10-18T08:00:00Z", 3)).toBe(false);
    expect(hasNewSince("2026-10-18T09:00:00Z", "2026-10-18T08:00:00Z", 3)).toBe(true);
  });

  it("goes away once the reader has been open, and comes back for a later arrival", async () => {
    const nav = render(<RssNavIndicator />);
    expect(await screen.findByRole("img", { name: "New articles" })).toBeInTheDocument();
    const r = reader();
    await waitFor(() => expect(screen.queryByRole("img", { name: "New articles" })).toBeNull());
    r.unmount();
    nav.unmount();

    latest = "2026-10-18T09:30:00.000Z";
    render(<RssNavIndicator />);
    expect(await screen.findByRole("img", { name: "New articles" })).toBeInTheDocument();
  });
});

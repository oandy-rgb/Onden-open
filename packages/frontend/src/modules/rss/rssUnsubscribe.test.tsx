import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 取消訂閱 in 閱讀 › RSS: the ⋯ beside a feed opens its sheet; Unsubscribe asks
// once, then posts the unsubscribe; the feed leaves the list and the notice
// says saved articles stay. A refusal keeps the sheet open with the error.

const { apiMock, sendWriteMock } = vi.hoisted(() => ({ apiMock: vi.fn(), sendWriteMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/data/onlineWrite", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/data/onlineWrite")>()), sendWrite: sendWriteMock }));

import RssReaderPanel from "./RssReaderPanel";

const source = (id: string, title: string) => ({
  id, title, url: `https://example.com/${id}.xml`, fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 1, created_at: "2026-10-01T00:00:00Z",
});

let sources = [source("s1", "Daily News"), source("s2", "Tech Blog")];

beforeEach(() => {
  sources = [source("s1", "Daily News"), source("s2", "Tech Blog")];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources, total_unseen: sources.length };
    if (path.startsWith("/api/rss/items")) return { items: [], next_cursor: null };
    return {};
  });
  sendWriteMock.mockReset();
});

/** 來源 sheet › the feed's ⋯ (feed management is not on the reading path). */
async function openFeedSettings(title: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Manage feeds" }));
  await userEvent.click(await screen.findByRole("button", { name: `Feed settings for ${title}` }));
}

const panel = () => render(<RssReaderPanel online onOpenNode={() => {}} />);

describe("RSS unsubscribe", () => {
  it("asks once, unsubscribes, and the feed leaves the list", async () => {
    sendWriteMock.mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith("/unsubscribe")) { sources = sources.filter((s) => s.id !== "s1"); return { unsubscribed: true }; }
      return {};
    });
    panel();
    await openFeedSettings("Daily News");
    const sheet = await screen.findByRole("dialog", { name: "Feed settings" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Unsubscribe" }));
    // Nothing sent until confirmed.
    expect(sendWriteMock).not.toHaveBeenCalled();
    expect(within(sheet).getByText(/Articles you saved stay where they are/)).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(sendWriteMock).toHaveBeenCalledWith("POST", "/api/rss/sources/s1/unsubscribe", {}));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/Unsubscribed from “Daily News”/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Daily News" })).toBeNull());
    expect(screen.getByRole("button", { name: "Tech Blog" })).toBeInTheDocument();
  });

  it("a refusal keeps the sheet open with the reason", async () => {
    sendWriteMock.mockRejectedValue(new Error("You cannot delete this note."));
    panel();
    await openFeedSettings("Daily News");
    const sheet = await screen.findByRole("dialog", { name: "Feed settings" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Unsubscribe" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Unsubscribe" }));
    expect(await within(sheet).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Feed settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Daily News" })).toBeInTheDocument();
  });
});

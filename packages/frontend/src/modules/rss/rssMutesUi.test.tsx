import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 靜音: a feed's ⋯ has 「靜音一週」; the Sources panel lists what is muted and can end it early.

const { apiMock, sendWriteMock } = vi.hoisted(() => ({ apiMock: vi.fn(), sendWriteMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api: apiMock }));
vi.mock("../../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/data")>()), sendWrite: sendWriteMock }));

import RssReaderPanel from "./RssReaderPanel";

const source = (id: string, title: string) => ({
  id, title, url: `https://example.com/${id}.xml`, fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 1, created_at: "2026-10-01T00:00:00Z",
});
let mutes: Array<Record<string, unknown>> = [];

beforeEach(() => {
  mutes = [];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources: [source("s1", "Daily News")], total_unseen: 1 };
    if (path.startsWith("/api/rss/mutes")) return { mutes };
    if (path.startsWith("/api/rss/items")) return { items: [], next_cursor: null };
    return {};
  });
  sendWriteMock.mockReset();
  sendWriteMock.mockResolvedValue({ id: "m1" });
});

const panel = () => render(<RssReaderPanel online onOpenNode={() => {}} />);

describe("RSS mutes", () => {
  it("「靜音一週」 mutes the feed, leaves its tag and says how to bring it back", async () => {
    panel();
    await userEvent.click(await screen.findByRole("button", { name: "Manage feeds" }));
    await userEvent.click(await screen.findByRole("button", { name: "Feed settings for Daily News" }));
    const sheet = await screen.findByRole("dialog", { name: "Feed settings" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Mute for a week" }));
    await waitFor(() => expect(sendWriteMock).toHaveBeenCalledWith("POST", "/api/rss/mutes", { source_id: "s1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/Muted “Daily News” for a week/)).toBeInTheDocument();
  });

  it("the Sources panel lists the muted and ends one early", async () => {
    mutes = [
      { id: "m1", keyword: "election", source_id: null, source_title: null, expires_at: "2026-11-09T00:00:00Z" },
      { id: "m2", keyword: null, source_id: "s1", source_title: "Daily News", expires_at: "2026-11-09T00:00:00Z" },
    ];
    panel();
    await userEvent.click(await screen.findByRole("button", { name: "Manage feeds" }));
    const list = await screen.findByText("Muted for now");
    const box = list.closest(".rss-mutes") as HTMLElement;
    expect(within(box).getByText(/Titles with “election”/)).toBeInTheDocument();
    expect(within(box).getByText(/Daily News \(all articles\)/)).toBeInTheDocument();
    mutes = [mutes[1]!];
    await userEvent.click(within(box).getAllByRole("button", { name: "Show again" })[0]!);
    await waitFor(() => expect(sendWriteMock).toHaveBeenCalledWith("DELETE", "/api/rss/mutes/m1"));
    await waitFor(() => expect(screen.queryByText(/Titles with “election”/)).toBeNull());
  });
});

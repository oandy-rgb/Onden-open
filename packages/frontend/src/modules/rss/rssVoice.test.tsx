import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 聲音: the tag shows only when a feed is a person's, asks the list for the people, and a feed's voice
// can be set when subscribing and changed afterwards.

const { apiMock, sendWriteMock, sendOrQueueMock } = vi.hoisted(() => ({ apiMock: vi.fn(), sendWriteMock: vi.fn(), sendOrQueueMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api: apiMock }));
vi.mock("../../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/data")>()), sendWrite: sendWriteMock, sendOrQueue: sendOrQueueMock }));

import RssReaderPanel from "./RssReaderPanel";

const source = (id: string, title: string, voice: "person" | "media") => ({
  id, title, url: `https://example.com/${id}.xml`, fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 1, created_at: "2026-10-01T00:00:00Z", voice,
});
let sources = [source("s1", "Daily News", "media"), source("s2", "Alice's Blog", "person")];

beforeEach(() => {
  sources = [source("s1", "Daily News", "media"), source("s2", "Alice's Blog", "person")];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources, total_unseen: 2 };
    if (path.startsWith("/api/rss/mutes")) return { mutes: [] };
    if (path.startsWith("/api/rss/items")) return { items: [], next_cursor: null };
    return {};
  });
  sendWriteMock.mockReset();
  sendWriteMock.mockResolvedValue({ voice: "media" });
  sendOrQueueMock.mockReset();
  sendOrQueueMock.mockResolvedValue({});
});

const panel = () => render(<RssReaderPanel online onOpenNode={() => {}} />);
const bar = () => within(screen.getByRole("toolbar", { name: "Feeds" }));

describe("the Voices tag", () => {
  it("is not there when no feed is a person's", async () => {
    sources = [source("s1", "Daily News", "media")];
    panel();
    await bar().findByRole("button", { name: "Daily News" });
    expect(bar().queryByRole("button", { name: "Voices" })).toBeNull();
  });

  it("asks the list for the people only", async () => {
    panel();
    await userEvent.click(await bar().findByRole("button", { name: "Voices" }));
    await waitFor(() => expect(apiMock.mock.calls.some((c) => String(c[0]).includes("voice=person") && !String(c[0]).includes("source="))).toBe(true));
    expect(bar().getByRole("button", { name: "Voices" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("a feed's voice", () => {
  it("is sent when chosen while subscribing, and left out on 「幫我判斷」", async () => {
    panel();
    await userEvent.click(await screen.findByRole("button", { name: "Manage feeds" }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.type(within(sheet).getByPlaceholderText(/Feed URL/i), "https://a.example/feed.xml");
    await userEvent.selectOptions(within(sheet).getByLabelText("Who writes it"), "person");
    await userEvent.click(within(sheet).getByRole("button", { name: /Subscribe/i }));
    await waitFor(() => expect(sendOrQueueMock).toHaveBeenCalled());
    expect(JSON.parse(sendOrQueueMock.mock.calls[0]![2])).toEqual({ url: "https://a.example/feed.xml", voice: "person" });
  });

  it("can be changed in the feed's settings", async () => {
    panel();
    await userEvent.click(await screen.findByRole("button", { name: "Manage feeds" }));
    await userEvent.click(await screen.findByRole("button", { name: "Feed settings for Alice's Blog" }));
    const sheet = await screen.findByRole("dialog", { name: "Feed settings" });
    await userEvent.selectOptions(within(sheet).getByLabelText("Who writes it"), "media");
    await waitFor(() => expect(sendWriteMock).toHaveBeenCalledWith("PATCH", "/api/rss/sources/s2", { voice: "media" }));
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Switching feeds quickly: the list must show the feed you ended on. A request
// sent earlier that answers later (a slow feed, a slow network) is not the
// answer to the question the list is asking now.

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
import { bindAccountStorage } from "../../lib/accountStorage";
import { resetAppState } from "../../lib/appStore";
import { noWorkspaceData } from "../../lib/api";

bindAccountStorage("unit-test-account", "");

const row = (id: string, title: string, source_id: string) => ({
  id, title, source_id, url: `https://example.com/${id}`, published_at: "2026-10-17T00:00:00Z",
  fetched_at: "2026-10-17T00:00:00Z", seen: false, saved_node_id: null, excerpt: "", image: null,
});
const feed = (id: string, title: string) => ({
  id, title, url: `https://example.com/${id}.xml`, fetch_interval_minutes: 60, last_fetched_at: null, last_error: null,
  auto_tag: null, embed: false, unseen: 1, created_at: "2026-10-01T00:00:00Z", latest_unseen_at: "2026-10-18T08:00:00.000Z",
});
const ITEMS: Record<string, ReturnType<typeof row>[]> = {
  s1: [row("a1", "Alpha story", "s1")],
  s2: [row("b1", "Bravo story", "s2")],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let pending: Record<string, ReturnType<typeof deferred<unknown>>>;

beforeEach(() => {
  localStorage.clear();
  forgetRssPrefs();
  resetAppState({ data: { ...noWorkspaceData }, online: true });
  pending = { s1: deferred(), s2: deferred() };
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/rss/sources")) return { sources: [feed("s1", "Daily News"), feed("s2", "Tech Blog")], total_unseen: 2, latest_unseen_at: null, module_default: null };
    if (path.startsWith("/api/rss/items")) {
      const source = new URL(path, "http://x").searchParams.get("source");
      return source ? pending[source]!.promise : { items: [], next_cursor: null };
    }
    return {};
  });
  sendWriteMock.mockReset();
  sendWriteMock.mockImplementation(async () => ({}));
});

describe("the article list when feeds are switched quickly", () => {
  it("shows the feed you ended on when the earlier request answers last", async () => {
    render(<RssReaderPanel online onOpenNode={() => {}} />);
    const bar = await screen.findByRole("toolbar", { name: "Feeds" });
    await userEvent.click(within(bar).getByRole("button", { name: "Daily News" })); // asks for s1 (slow)
    await userEvent.click(within(bar).getByRole("button", { name: "Tech Blog" })); // asks for s2
    await waitFor(() => expect(apiMock.mock.calls.filter(([p]) => String(p).includes("source=s2"))).toHaveLength(1));

    await act(async () => { pending.s2.resolve({ items: ITEMS.s2, next_cursor: null }); });
    expect(await screen.findByRole("button", { name: /Bravo story/ })).toBeInTheDocument();

    await act(async () => { pending.s1.resolve({ items: ITEMS.s1, next_cursor: null }); }); // the late one
    expect(screen.getByRole("button", { name: /Bravo story/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Alpha story/ })).toBeNull();
  });

  it("a late failure of the earlier request does not blank the list or raise a notice", async () => {
    render(<RssReaderPanel online onOpenNode={() => {}} />);
    const bar = await screen.findByRole("toolbar", { name: "Feeds" });
    await userEvent.click(within(bar).getByRole("button", { name: "Daily News" }));
    await userEvent.click(within(bar).getByRole("button", { name: "Tech Blog" }));
    await waitFor(() => expect(apiMock.mock.calls.filter(([p]) => String(p).includes("source=s2"))).toHaveLength(1));
    await act(async () => { pending.s2.resolve({ items: ITEMS.s2, next_cursor: null }); });
    await screen.findByRole("button", { name: /Bravo story/ });

    await act(async () => { pending.s1.resolve(Promise.reject(new Error("late failure"))); });
    expect(screen.getByRole("button", { name: /Bravo story/ })).toBeInTheDocument();
    expect(screen.queryByText("Could not load articles")).toBeNull();
  });
});

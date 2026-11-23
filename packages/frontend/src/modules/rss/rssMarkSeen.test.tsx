import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Leaving an article marks it seen. The mark rides the offline queue (seen is idempotent), and when the server
// refuses it the row goes back to unseen with one plain sentence — a row that looks seen but isn't would be
// unread again after a reload.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api: apiMock }));
vi.mock("../../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(), clearPendingWrite: vi.fn(async () => {}),
  upsertAttribute: vi.fn(async () => null),
  storeRejectedWrite: vi.fn(async (request, rejection) => ({ ...request, id: 301, attempts: 0, rejection })),
}));

import RssReaderPanel from "./RssReaderPanel";
import { ApiError, noWorkspaceData } from "../../lib/api";
import { addPendingWrite, getPendingWrites, clearPendingWrite } from "../../lib/localDb";
import { resetAppState } from "../../lib/appStore";
import { bindAccountStorage } from "../../lib/accountStorage";
import { forgetRssPrefs } from "./rssPrefs";
import { memoryQueue } from "../../test/helpers/memoryQueue";

bindAccountStorage("unit-test-account", "");
const row = (id: string, title: string) => ({
  id, title, source_id: "s1", url: `https://example.com/${id}`, published_at: "2026-10-17T00:00:00Z",
  fetched_at: "2026-10-17T00:00:00Z", seen: false, saved_node_id: null, excerpt: "", image: null,
});
const ROWS = [row("i1", "First story"), row("i2", "Second story")];
const feed = { id: "s1", title: "Daily News", url: "https://example.com/feed.xml", fetch_interval_minutes: 60, last_fetched_at: null,
  last_error: null, auto_tag: null, embed: false, unseen: 2, created_at: "2026-10-01T00:00:00Z", latest_unseen_at: "2026-10-18T08:00:00.000Z" };
let queue: ReturnType<typeof memoryQueue>;
let seenAnswer: () => Promise<unknown>;

beforeEach(() => {
  localStorage.clear();
  forgetRssPrefs();
  resetAppState({ data: { ...noWorkspaceData }, online: true });
  queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (/\/seen$/.test(path)) return seenAnswer();
    if (path.startsWith("/api/rss/sources")) return { sources: [feed], total_unseen: 2, latest_unseen_at: feed.latest_unseen_at, module_default: null };
    const one = /^\/api\/rss\/items\/(i\d)$/.exec(path);
    if (one) return { ...ROWS.find((r) => r.id === one[1])!, body: `<p>${"Body text. ".repeat(80)}</p>` };
    if (path.startsWith("/api/rss/items")) return { items: ROWS, next_cursor: null };
    return {};
  });
});

async function readFirstThenBackToList() {
  render(<RssReaderPanel online onOpenNode={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /First story/ }));
  await screen.findByRole("heading", { name: /First story/ });
  await userEvent.click(screen.getByRole("button", { name: "Back to list" }));
  return await screen.findByRole("button", { name: /First story/ });
}

describe("marking an article seen", () => {
  it("a refused mark puts the row back to unseen and says so", async () => {
    seenAnswer = async () => { throw new ApiError(403, "forbidden"); };
    const item = await readFirstThenBackToList();
    await waitFor(() => expect(item).not.toHaveClass("read"));
    await waitFor(() => expect(document.querySelector(".rss-notice")?.textContent).toBeTruthy());
  });

  it("a mark that cannot be sent yet is kept in the offline queue and the row stays seen", async () => {
    seenAnswer = async () => { throw new TypeError("Failed to fetch"); };
    const item = await readFirstThenBackToList();
    await waitFor(() => expect(queue.rows.some((r) => r.method === "POST" && r.path === "/api/rss/items/i1/seen")).toBe(true));
    expect(item).toHaveClass("read");
  });
});

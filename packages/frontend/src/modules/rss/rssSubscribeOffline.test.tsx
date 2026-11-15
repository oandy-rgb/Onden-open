import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Subscribing to an RSS feed must work OFFLINE: the subscribe is captured into the
// pending-write queue and replayed on reconnect (the server validates + fetches
// the feed then). The button was disabled offline and the call went straight to
// api() with no queue, so an offline subscribe was simply impossible.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
}));

import RssReaderPanel from "./RssReaderPanel";
import { addPendingWrite } from "../../lib/localDb";

function answerOffline() {
  apiMock.mockImplementation(async (path: string) => {
    if (typeof path === "string" && path.includes("/api/rss/subscribe")) throw new TypeError("Failed to fetch");
    return { items: [], sources: [], total_unread: 0 };
  });
}

// The first render of the panel and the first user-event gesture in a file
// pay a one-time start-up (~0.4 s idle, several seconds on a busy machine),
// which pushed the test past its 5 s timeout. Pay it here, with its own
// budget, so the test times only the subscribe itself.
beforeAll(async () => {
  answerOffline();
  render(<RssReaderPanel online={false} onClose={() => {}} onOpenNode={() => {}} onRefresh={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /Manage feeds/i }));
  await userEvent.type(screen.getByPlaceholderText(/Feed URL/i), "x");
  cleanup();
}, 30_000);

beforeEach(() => {
  apiMock.mockReset();
  vi.mocked(addPendingWrite).mockClear();
  // GETs (items/sources) resolve empty; the subscribe POST fails like an offline
  // transport error so sendOrQueue queues it.
  answerOffline();
});

describe("RSS subscribe works offline (queues)", () => {
  it("the subscribe button is enabled offline and queues the subscribe", async () => {
    render(<RssReaderPanel online={false} onClose={() => {}} onOpenNode={() => {}} onRefresh={() => {}} />);

    // Management UI is folded by default — open the 來源 sheet first.
    await userEvent.click(screen.getByRole("button", { name: /Manage feeds/i }));
    const input = screen.getByPlaceholderText(/Feed URL/i);
    await userEvent.type(input, "https://example.com/feed.xml");
    const btn = screen.getByRole("button", { name: /Subscribe/i });
    expect(btn, "subscribe is clickable while offline").not.toBeDisabled();

    await userEvent.click(btn);

    await waitFor(() => {
      const call = vi.mocked(addPendingWrite).mock.calls.find(
        (c) => typeof c[1] === "string" && c[1].includes("/api/rss/subscribe"),
      );
      expect(call, "the offline subscribe was queued").toBeTruthy();
      expect(c0Body(call!)).toEqual({ url: "https://example.com/feed.xml" });
    });
    // A queued subscription says it is not subscribed yet, not the generic "will sync" sentence.
    expect(await screen.findByText("Saved on this device — we'll subscribe when the server is reachable.")).toBeInTheDocument();
  });
});

function c0Body(call: unknown[]): unknown {
  // addPendingWrite(method, path, body, idemKey) — body is the 3rd arg.
  return JSON.parse(String(call[2]));
}

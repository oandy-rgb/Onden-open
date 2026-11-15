import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// Review counts are clock-driven: a card falling due emits no event, so the
// stats/decks must re-read on their interval even while the live stream is
// connected and quiet (note-d6's review of #57).
const live = vi.hoisted(() => ({ connected: true }));
vi.mock("../../lib/liveEvents", () => ({
  isLiveConnected: () => live.connected,
  subscribeLiveTicks: (_tick: unknown, connection?: (up: boolean) => void) => { connection?.(live.connected); return () => {}; },
}));
const api = vi.hoisted(() => vi.fn(async () => ({ due: 0 })));
// The read goes through lib/data (reads.modules), which needs the rest of lib/api too.
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api }));

const { useLiveResource } = await import("./useLiveResource");

afterEach(() => { vi.useRealTimers(); api.mockClear(); });

describe("useLiveResource", () => {
  it("re-reads every pollMs even while the stream is connected", async () => {
    vi.useFakeTimers();
    renderHook(() => useLiveResource("/api/review/stats", (raw: { due: number }) => raw.due, null, 60_000));
    await act(async () => { await Promise.resolve(); });
    const afterMount = api.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(api.mock.calls.length).toBe(afterMount + 1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(api.mock.calls.length).toBe(afterMount + 2);
  });
});

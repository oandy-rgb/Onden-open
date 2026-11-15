import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../lib/api";
import { useLiveEventLog } from "../hooks/useLiveEventLog";
import { type LiveEvent } from "../lib/liveEvent";

const live = vi.hoisted(() => ({ changed: () => {}, connection: (_up: boolean) => {} }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/liveEvents", () => ({
  isLiveConnected: () => false,
  subscribeLiveTicks: (onTick: (tick: { kind: string }) => void, onConnection: (up: boolean) => void) => {
    live.changed = () => onTick({ kind: "changed" });
    live.connection = onConnection;
    return vi.fn();
  },
}));

function event(id: number, target_id = "a"): LiveEvent {
  return { id, target_id, target_type: "node", actor_type: "user", actor_id: "u",
    event_type: "NODE_UPDATED", payload: {}, created_at: "2026-09-12T00:00:00Z" };
}
function page(...events: LiveEvent[]) { return { events, count: events.length }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const mockApi = vi.mocked(api);
function useHistory(target: string) {
  return useLiveEventLog({ query: { target_id: target }, intervalMs: 60_000 });
}
async function tick() {
  act(() => live.changed());
  // Also supports the old hook's zero-delay scheduling, to reproduce regressions.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
}

beforeEach(() => { mockApi.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("event history query ownership", () => {
  it("clears the previous note's actionable rows while the next note loads", async () => {
    const next = deferred<ReturnType<typeof page>>();
    mockApi.mockResolvedValueOnce(page(event(10))).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(useHistory, { initialProps: "a" });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    rerender("b");
    expect(result.current.events).toEqual([]);
    expect(result.current.loading).toBe(true);
    await act(async () => next.resolve(page(event(20, "b"))));
    expect(result.current.events.map(e => e.id)).toEqual([20]);
  });

  it.each(["success", "failure"])("ignores a late %s from the previous query", async outcome => {
    const previous = deferred<ReturnType<typeof page>>();
    mockApi.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(page(event(20, "b")));
    const { result, rerender } = renderHook(useHistory, { initialProps: "a" });
    const staleReload = result.current.reload;
    rerender("b");
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      if (outcome === "success") previous.resolve(page(event(90)));
      else previous.reject(new Error("old query failed"));
    });
    expect(result.current.events.map(e => e.id)).toEqual([20]);
    expect(result.current.error).toBeNull();
    expect(await staleReload()).toBe(false);
    mockApi.mockResolvedValueOnce(page());
    await tick();
    const params = new URL(mockApi.mock.lastCall![0], "http://test").searchParams;
    expect(params.get("target_id")).toBe("b");
    expect(params.get("since")).toBe("20");
  });

  it("does not revive the first A request after A → B → A", async () => {
    const first = deferred<ReturnType<typeof page>>();
    mockApi.mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page(event(20, "b")))
      .mockResolvedValueOnce(page(event(30)));
    const { result, rerender } = renderHook(useHistory, { initialProps: "a" });
    const firstReload = result.current.reload;
    rerender("b");
    await waitFor(() => expect(result.current.events[0]?.id).toBe(20));
    rerender("a");
    await waitFor(() => expect(result.current.events[0]?.id).toBe(30));
    await act(async () => first.resolve(page(event(10))));
    expect(result.current.events.map(e => e.id)).toEqual([30]);
    expect(await firstReload()).toBe(false);
  });

  it("retains same-query rows on refresh failure, then recovers with an explicit result", async () => {
    mockApi.mockResolvedValueOnce(page(event(10)));
    const { result } = renderHook(() => useHistory("a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockApi.mockRejectedValueOnce(new ApiError(500, JSON.stringify({ error: "internal" })));
    await act(async () => expect(await result.current.reload()).toBe(false));
    expect(result.current.events.map(e => e.id)).toEqual([10]);
    expect(result.current.error).toBe("Something went wrong on the server.");
    expect(result.current.isLive).toBe(false);
    mockApi.mockResolvedValueOnce(page(event(11), event(10)));
    await act(async () => expect(await result.current.reload()).toBe(true));
    expect(result.current.events.map(e => e.id)).toEqual([11, 10]);
    expect(result.current.error).toBeNull();
  });

  it("settles a pending reload as false and cancels the request when leaving its query", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    mockApi.mockResolvedValueOnce(page(event(10)));
    const { result, unmount } = renderHook(() => useHistory("a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockApi.mockReturnValueOnce(pending.promise);
    let reloaded!: Promise<boolean>;
    act(() => { reloaded = result.current.reload(); });
    const signal = mockApi.mock.lastCall![1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(await reloaded).toBe(false);
    await act(async () => pending.resolve(page(event(12))));
  });
});

describe("event history read ordering", () => {
  it("retries a failed initial read as a snapshot", async () => {
    mockApi.mockRejectedValueOnce(new ApiError(500, JSON.stringify({ error: "internal" }))).mockResolvedValueOnce(page(event(9), event(8)));
    const { result } = renderHook(() => useHistory("a"));
    await waitFor(() => expect(result.current.error).toBe("Something went wrong on the server."));
    await tick();
    expect(result.current.events.map(e => e.id)).toEqual([9, 8]);
    expect(mockApi.mock.calls[1][0]).not.toContain("since=");
  });

  it("catches up on reconnect and visibility return, while hidden ticks do not read", async () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    mockApi.mockResolvedValueOnce(page(event(10))).mockResolvedValue(page());
    const { result } = renderHook(() => useHistory("a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    await tick();
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(result.current.isLive).toBe(false);
    await act(async () => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    expect(mockApi).toHaveBeenCalledTimes(2);
    await act(async () => live.connection(true));
    expect(mockApi).toHaveBeenCalledTimes(3);
    await act(async () => { live.connection(false); live.connection(true); });
    expect(mockApi).toHaveBeenCalledTimes(4);
    expect(result.current.isLive).toBe(true);
  });

  it("waits for the initial snapshot before consuming ticks and keeps events unique", async () => {
    const initial = deferred<ReturnType<typeof page>>();
    mockApi.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(page(event(11), event(12)));
    const { result } = renderHook(() => useHistory("a"));
    await tick();
    expect(mockApi).toHaveBeenCalledTimes(1);
    await act(async () => initial.resolve(page(event(10))));
    await waitFor(() => expect(result.current.events.map(e => e.id)).toEqual([12, 11, 10]));
    expect(mockApi.mock.calls[1][0]).toContain("since=10");
  });

  it("queues a refresh after an in-flight delta and catches a tick during that refresh", async () => {
    const delta = deferred<ReturnType<typeof page>>();
    const snapshot = deferred<ReturnType<typeof page>>();
    mockApi.mockResolvedValueOnce(page(event(10))).mockReturnValueOnce(delta.promise)
      .mockReturnValueOnce(snapshot.promise).mockResolvedValueOnce(page(event(13)));
    const { result } = renderHook(() => useHistory("a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await tick();
    let refreshed!: Promise<boolean>;
    act(() => { refreshed = result.current.reload(); });
    expect(mockApi).toHaveBeenCalledTimes(2);
    await act(async () => delta.resolve(page(event(11))));
    expect(mockApi).toHaveBeenCalledTimes(3);
    expect(mockApi.mock.calls[2][0]).not.toContain("since=");
    await tick();
    expect(mockApi).toHaveBeenCalledTimes(3);
    await act(async () => snapshot.resolve(page(event(12), event(11), event(10))));
    expect(await refreshed).toBe(true);
    await waitFor(() => expect(result.current.events.map(e => e.id)).toEqual([13, 12, 11, 10]));
    expect(mockApi.mock.calls[3][0]).toContain("since=12");
  });

  it("reads forward from an empty log with since=0 and drains every full page", async () => {
    mockApi.mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page(event(1), event(2)))
      .mockResolvedValueOnce(page(event(3), event(4)))
      .mockResolvedValueOnce(page(event(5)));
    const { result } = renderHook(() => useLiveEventLog({ query: { limit: "2" }, intervalMs: 60_000 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await tick();
    expect(result.current.events.map(e => e.id)).toEqual([5, 4, 3, 2, 1]);
    expect(mockApi.mock.calls.slice(1).map(([url]) => new URL(url, "http://test").searchParams.get("since")))
      .toEqual(["0", "2", "4"]);
  });
});

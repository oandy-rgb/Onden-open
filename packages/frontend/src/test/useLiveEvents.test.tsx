// The shared blind-tick SSE stream (lib/liveEvents.ts), the one place
// that decides what to refetch on it (lib/liveInvalidation.ts — topics, the
// reopened stream, the tab coming back, the echo of this tab's own writes),
// and the tick-driven useLiveEventLog.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { subscribeLiveTicks, isLiveConnected, _resetLiveEventsForTests } from "../lib/liveEvents";
import { ECHO_MS, noteLocalWrite, register, _resetLiveInvalidationForTests } from "../lib/liveInvalidation";
import { useLiveEventLog } from "../hooks/useLiveEventLog";

// ── Fake EventSource ─────────────────────────────────────────────────────────
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static last(): FakeEventSource {
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!es) throw new Error("no EventSource constructed");
    return es;
  }
  url: string;
  withCredentials: boolean;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  // test drivers
  open() { this.onopen?.(); }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  fail() { this.onerror?.(); }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  _resetLiveInvalidationForTests();
  _resetLiveEventsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("liveInvalidation", () => {
  it("routes ticks to their topics, over one credentialed stream", async () => {
    const changed = vi.fn(), effects = vi.fn(), membership = vi.fn();
    register("changed", changed); register("effects", effects); register("membership", membership);
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.last();
    expect(es.url).toContain("/api/events/stream");
    expect(es.withCredentials).toBe(true);
    act(() => { es.emit({ kind: "changed", latest: 42 }); es.emit({ kind: "effects" }); es.emit({ kind: "membership_changed", epoch: 14 }); });
    await flush();
    expect(changed).toHaveBeenCalledWith({ kind: "changed", latest: 42 });
    expect(effects).toHaveBeenCalledTimes(1);
    expect(membership).toHaveBeenCalledWith({ kind: "membership_changed", epoch: 14 });
  });

  it("drops anything that isn't exactly a blind tick", async () => {
    const changed = vi.fn(), membership = vi.fn();
    register("changed", changed); register("membership", membership);
    const es = FakeEventSource.last();
    act(() => {
      es.onmessage?.({ data: "not json" });
      es.emit({ kind: "changed" });               // missing latest
      es.emit({ kind: "surprise", id: "n1" });    // unknown kind
      es.emit({ kind: "membership_changed" });     // missing epoch
    });
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(membership).not.toHaveBeenCalled();
  });

  it("a reopened stream runs the reconnect handshake and the changed refetches (unless they opt out)", async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn(), changed = vi.fn(), optedOut = vi.fn();
    register("reconnect", reconnect); register("changed", changed); register("changed", optedOut, { onReconnect: false });
    act(() => FakeEventSource.last().open());
    await flush();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    act(() => FakeEventSource.last().fail());
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => FakeEventSource.last().open());
    await flush();
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(optedOut).not.toHaveBeenCalled();
  });

  it("a tick during a running refetch queues ONE more run — nothing lost, a burst is one extra fetch", async () => {
    let release!: () => void;
    const changed = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    register("changed", changed);
    const es = FakeEventSource.last();
    act(() => es.emit({ kind: "changed", latest: 1 }));
    await flush();
    act(() => { es.emit({ kind: "changed", latest: 2 }); es.emit({ kind: "changed", latest: 3 }); });
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await flush();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("after a local write, the echo ticks of a save collapse into ONE trailing refetch (where opted in)", async () => {
    vi.useFakeTimers();
    const changed = vi.fn(), immediate = vi.fn();
    register("changed", changed, { collapseEcho: true });
    register("changed", immediate);
    const es = FakeEventSource.last();
    noteLocalWrite();
    act(() => { es.emit({ kind: "changed", latest: 10 }); es.emit({ kind: "changed", latest: 11 }); es.emit({ kind: "changed", latest: 12 }); });
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(immediate).toHaveBeenCalled(); // not opted in: reads at once
    await act(async () => { vi.advanceTimersByTime(ECHO_MS); });
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    // Outside the window, a tick refetches at once again.
    act(() => es.emit({ kind: "changed", latest: 13 }));
    await flush();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("polls only while the stream is down, and refetches when the tab comes back", async () => {
    vi.useFakeTimers();
    const polled = vi.fn(), visible = vi.fn();
    register("changed", polled, { pollMs: 60_000 });
    register("visible", visible);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(polled).toHaveBeenCalledTimes(1);          // stream not open yet → poll
    act(() => FakeEventSource.last().open());        // reopened → one reconnect refetch
    expect(polled).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(polled).toHaveBeenCalledTimes(2);          // stream up: no poll
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(visible).toHaveBeenCalledTimes(1);
  });

  it("reports connection state", () => {
    register("changed", vi.fn());
    expect(isLiveConnected()).toBe(false);
    act(() => FakeEventSource.last().open());
    expect(isLiveConnected()).toBe(true);
  });
});

describe("the workspace sync registration", () => {
  it("catches up on foreground, on coming online, and by poll while the stream is down", async () => {
    vi.useFakeTimers();
    const sync = vi.fn();
    register("changed", sync, { onReconnect: false, collapseEcho: true, onVisible: true, onOnline: true, pollMs: 60_000 });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event("online")); });
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(sync).toHaveBeenCalledTimes(3);
  });
});

describe("the live stream", () => {
  it("reconnects with exponential backoff after errors, resets on success", () => {
    vi.useFakeTimers();
    subscribeLiveTicks(() => {});
    expect(FakeEventSource.instances.length).toBe(1);

    // 1st failure → retry after 1s.
    act(() => FakeEventSource.last().fail());
    act(() => { vi.advanceTimersByTime(999); });
    expect(FakeEventSource.instances.length).toBe(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeEventSource.instances.length).toBe(2);

    // 2nd failure → backoff doubled: nothing at +1s, reconnect at +2s.
    act(() => FakeEventSource.last().fail());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeEventSource.instances.length).toBe(2);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeEventSource.instances.length).toBe(3);

    // A successful open resets the ladder back to 1s.
    act(() => FakeEventSource.last().open());
    act(() => FakeEventSource.last().fail());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeEventSource.instances.length).toBe(4);
  });

  it("a stream that goes silent for ~60 s is dropped and reopened; heartbeats keep it alive", () => {
    vi.useFakeTimers();
    subscribeLiveTicks(() => {});
    const first = FakeEventSource.last();
    act(() => first.open());
    // A heartbeat frame every 25 s keeps the connection.
    for (let i = 0; i < 4; i++) {
      act(() => { vi.advanceTimersByTime(25_000); first.emit({ kind: "heartbeat" }); });
    }
    expect(first.closed).toBe(false);
    expect(isLiveConnected()).toBe(true);
    // Then nothing arrives: half-open.
    act(() => { vi.advanceTimersByTime(75_000); });
    expect(first.closed).toBe(true);
    expect(isLiveConnected()).toBe(false);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it("closes the shared stream when the last subscriber leaves", () => {
    const unsub = subscribeLiveTicks(() => {});
    const es = FakeEventSource.last();
    expect(es.closed).toBe(false);
    unsub();
    expect(es.closed).toBe(true);
  });
});

describe("useLiveEventLog over SSE ticks", () => {
  it("a changed tick triggers an immediate incremental fetch (no poll wait)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // First call = initial page (one event, id 7); later calls = ?since=7.
      const body = url.includes("since=")
        ? { events: [], count: 0 }
        : { events: [{ id: 7, actor_type: "user", actor_id: "a", event_type: "NODE_CREATED", target_type: "node", target_id: "n", payload: {}, created_at: "now" }], count: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const { result } = renderHook(() => useLiveEventLog({ intervalMs: 60_000 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = calls.length;

    const es = FakeEventSource.last();
    act(() => {
      es.open();
      es.emit({ kind: "changed", latest: 8 });
    });
    // The tick scheduled an immediate fetch — far sooner than the 60s poll.
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls[calls.length - 1]).toContain("since=7");
  });

  it("falls back to the periodic poll when the EventSource errors", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ events: [], count: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLiveEventLog({ intervalMs: 50 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // SSE never connects — kill it. The hook must keep polling on intervalMs.
    act(() => FakeEventSource.last().fail());
    const before = fetchMock.mock.calls.length;
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before), { timeout: 2_000 });
  });
});

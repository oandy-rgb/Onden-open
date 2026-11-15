// sqljs-export-jank: the persist scheduler must keep the expensive db.export()
// off the keystroke hot path — it debounces/coalesces bursts and defers the
// export to idle — while still guaranteeing durability via a synchronous flush
// on unload. These tests drive the pure scheduler with fake timers + a spy so
// no sql.js / IndexedDB is needed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPersistScheduler } from "../lib/persistScheduler";

describe("createPersistScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default jsdom has no requestIdleCallback; install a deterministic one
    // that the scheduler will prefer over the setTimeout(0) fallback.
    (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) =>
      setTimeout(cb, 0) as unknown as number;
    (globalThis as Record<string, unknown>).cancelIdleCallback = (h: number) =>
      clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).requestIdleCallback;
    delete (globalThis as Record<string, unknown>).cancelIdleCallback;
  });

  it("cancel() drops a pending save without exporting and reports whether one was pending", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    expect(s.isDirty()).toBe(false);
    s.schedule();
    expect(s.isDirty()).toBe(true);
    expect(s.cancel()).toBe(true);
    expect(s.isDirty()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(doExport).not.toHaveBeenCalled();
    expect(s.cancel()).toBe(false);
  });

  it("does NOT export synchronously on schedule() — the hot path stays free", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    s.schedule();
    expect(doExport).not.toHaveBeenCalled();
  });

  it("coalesces a burst of edits into a single deferred export", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    for (let i = 0; i < 10; i++) {
      s.schedule();
      vi.advanceTimersByTime(100); // edits 100ms apart — never crosses the debounce
    }
    expect(doExport).not.toHaveBeenCalled();
    // Let debounce fire, then the idle callback run.
    vi.advanceTimersByTime(2000); // debounce -> arms idle
    vi.advanceTimersByTime(1); // idle callback
    expect(doExport).toHaveBeenCalledTimes(1);
  });

  it("eventually exports after the debounce + idle settle", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    s.schedule();
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(1);
    expect(doExport).toHaveBeenCalledTimes(1);
  });

  it("flushSync() exports immediately and cancels the pending deferred work", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    s.schedule();
    s.flushSync();
    expect(doExport).toHaveBeenCalledTimes(1);
    // No double export when the (now-cancelled) timers would have fired.
    vi.advanceTimersByTime(5000);
    expect(doExport).toHaveBeenCalledTimes(1);
  });

  it("flushSync() is a no-op when nothing is dirty", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    s.flushSync();
    expect(doExport).not.toHaveBeenCalled();
  });

  it("falls back to setTimeout when requestIdleCallback is unavailable", () => {
    delete (globalThis as Record<string, unknown>).requestIdleCallback;
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    s.schedule();
    vi.advanceTimersByTime(2000); // debounce -> arms setTimeout(0) fallback
    vi.advanceTimersByTime(1);
    expect(doExport).toHaveBeenCalledTimes(1);
  });

  it("a mutation during the dirty cycle is not lost (re-arms a fresh save)", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    s.schedule();
    s.flushSync(); // first export
    expect(doExport).toHaveBeenCalledTimes(1);
    s.schedule(); // new edit after flush
    s.flushSync();
    expect(doExport).toHaveBeenCalledTimes(2);
  });

  it("flushes on pagehide and when the page is hidden (durability barrier)", () => {
    const doExport = vi.fn();
    const s = createPersistScheduler({ doExport, debounceMs: 2000 });
    s.schedule(); // binds the unload listeners on first schedule
    window.dispatchEvent(new Event("pagehide"));
    expect(doExport).toHaveBeenCalledTimes(1);
    s.schedule();
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    state.mockRestore();
    expect(doExport).toHaveBeenCalledTimes(2);
  });
});

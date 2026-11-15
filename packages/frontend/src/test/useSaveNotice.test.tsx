import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW_SAVE_MS, useSaveNotice } from "../lib/useSaveNotice";
import type { SaveStatus } from "../lib/appStore";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

type Props = { status: SaveStatus; online: boolean; id: string; edit?: string };
const run = (status: SaveStatus, online = true, id = "a") =>
  renderHook((p: Props) => useSaveNotice(p.status, p.online, p.id, p.edit ?? ""),
    { initialProps: { status, online, id } as Props });

describe("useSaveNotice", () => {
  it("shows nothing for saved, unsaved and saving at first", () => {
    for (const s of ["saved", "unsaved", "saving"] as const) expect(run(s).result.current).toBe("none");
  });

  it("keeps queued and rejected visible at once", () => {
    expect(run("queued").result.current).toBe("queued");
    expect(run("rejected").result.current).toBe("rejected");
  });

  it("says slow after 5s unsaved/saving online, and clears when saved", () => {
    const { result, rerender } = run("unsaved");
    act(() => { vi.advanceTimersByTime(SLOW_SAVE_MS - 1); });
    expect(result.current).toBe("none");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe("slow");
    rerender({ status: "saving", online: true, id: "a" });
    expect(result.current).toBe("slow");
    rerender({ status: "saved", online: true, id: "a" });
    expect(result.current).toBe("none");
  });

  it("restarts the wait for a new edit after a save", () => {
    const { result, rerender } = run("unsaved");
    act(() => { vi.advanceTimersByTime(4000); });
    rerender({ status: "saved", online: true, id: "a" });
    rerender({ status: "unsaved", online: true, id: "a" });
    act(() => { vi.advanceTimersByTime(4000); });
    expect(result.current).toBe("none");
  });

  it("stays quiet while the person keeps typing (autosave waits for a pause)", () => {
    const { result, rerender } = run("unsaved");
    for (let i = 1; i <= 12; i++) {
      act(() => { vi.advanceTimersByTime(1000); });
      rerender({ status: "unsaved", online: true, id: "a", edit: "x".repeat(i) });
    }
    expect(result.current).toBe("none");
    act(() => { vi.advanceTimersByTime(SLOW_SAVE_MS); });
    expect(result.current).toBe("slow");
  });

  it("never says slow while offline", () => {
    const { result } = run("unsaved", false);
    act(() => { vi.advanceTimersByTime(SLOW_SAVE_MS * 3); });
    expect(result.current).toBe("none");
  });

  it("drops the stall notice and restarts the timer on a note switch", () => {
    const { result, rerender } = run("unsaved");
    act(() => { vi.advanceTimersByTime(SLOW_SAVE_MS); });
    expect(result.current).toBe("slow");
    rerender({ status: "unsaved", online: true, id: "b" });
    expect(result.current).toBe("none");
    act(() => { vi.advanceTimersByTime(SLOW_SAVE_MS); });
    expect(result.current).toBe("slow");
  });

  it("clears its timer on unmount", () => {
    const { unmount } = run("saving");
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

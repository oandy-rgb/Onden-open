import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, renderHook } from "@testing-library/react";
import SyncStatus, { useSyncTrouble } from "../components/SyncStatus";
import { setLocalOnlyStatus } from "../lib/localOnlyStatus";

// A build that keeps the notes only on this device (the browser trial) says so where the app shows its save
// status, and a problem there becomes the same "saving trouble" the avatar badge shows (owner, 2026-11-02).
describe("the save line when notes are kept only on this device", () => {
  afterEach(() => { act(() => setLocalOnlyStatus(null)); });

  it("says where the notes are, and pressing it opens what the shell offers", () => {
    const open = vi.fn();
    act(() => setLocalOnlyStatus({ label: "Only in this browser · saved", trouble: null, open }));
    render(<SyncStatus expanded />);
    fireEvent.click(screen.getByRole("button", { name: "Only in this browser · saved" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("a problem replaces the calm line and is the saving trouble; none without one", () => {
    act(() => setLocalOnlyStatus({ label: "Only in this browser · saved", trouble: "Time to download a backup", open: () => {} }));
    render(<SyncStatus expanded />);
    expect(screen.getByRole("button", { name: "Time to download a backup" })).toBeTruthy();
    expect(renderHook(() => useSyncTrouble()).result.current).toEqual({ kind: "error", label: "Time to download a backup" });
    act(() => setLocalOnlyStatus({ label: "Only in this browser · saved", trouble: null, open: () => {} }));
    expect(renderHook(() => useSyncTrouble()).result.current).toBeNull();
  });

  it("is the ordinary sync status when no shell set it", () => {
    render(<SyncStatus expanded />);
    expect(screen.queryByText(/Only in this browser/)).toBeNull();
  });
});

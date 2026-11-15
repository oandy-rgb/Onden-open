import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import MembershipGate from "../components/MembershipGate";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("workspace check recovery", () => {
  it("recovers a failed startup check automatically while keeping the gate visible", async () => {
    const retry = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const view = render(<MembershipGate onRetry={retry} />);
    await advance(5000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Sync could not finish");
    expect(screen.getByRole("status")).toHaveTextContent("Checking your workspace");
    await advance(5000);
    expect(retry).toHaveBeenCalledTimes(2);
    // Only the sync owner can remove the gate; this component never reveals data.
    expect(screen.getByRole("status")).toBeVisible();
    view.unmount();
    await advance(60000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated failures instead of polling a failed server constantly", async () => {
    const retry = vi.fn().mockResolvedValue({ ok: false });
    render(<MembershipGate onRetry={retry} />);
    for (const delay of [5000, 5000, 10000, 20000, 30000]) await advance(delay);
    expect(retry).toHaveBeenCalledTimes(5);
    await advance(29999);
    expect(retry).toHaveBeenCalledTimes(5);
    await advance(1);
    expect(retry).toHaveBeenCalledTimes(6);
  });

  it("manual retry runs immediately and cannot overlap an active check", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const retry = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
    render(<MembershipGate onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await advance(60000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toBeDisabled();
    await act(async () => { finish({ ok: true }); });
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("stops background retries when hidden and checks again when visible", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const retry = vi.fn().mockResolvedValue({ ok: true });
    render(<MembershipGate onRetry={retry} />);
    await advance(60000);
    expect(retry).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await advance(0);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("ignores a late failure after unmount and does not schedule more work", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const retry = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
    const view = render(<MembershipGate onRetry={retry} />);
    await advance(5000);
    expect(retry).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => { finish({ ok: false }); });
    await advance(60000);
    expect(retry).toHaveBeenCalledOnce();
  });
  it("keeps retrying when an ok pass is followed by a dirty check and the gate remains mounted", async () => {
    const retry = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    render(<MembershipGate onRetry={retry} />);
    await advance(5000);
    expect(retry).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("Sync could not finish");
    await advance(10000);
    expect(retry).toHaveBeenCalledTimes(3);
  });

});

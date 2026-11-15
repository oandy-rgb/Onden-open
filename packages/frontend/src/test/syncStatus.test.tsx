import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
  addPendingWrite: vi.fn(async () => null),
}));

import { getPendingWrites } from "../lib/localDb";
import { bumpPending, setPending, refreshPendingCount, getPendingCount, usePendingWrites } from "../lib/data/syncStatus";
import { queueWrite } from "../lib/data/writeQueue";

function Chip() {
  const n = usePendingWrites();
  return <span data-testid="count">{n}</span>;
}

describe("syncStatus (P0-4)", () => {
  beforeEach(() => {
    setPending(0);
    vi.mocked(getPendingWrites).mockClear();
  });

  it("queueWrite updates the counter when the write enters the queue", async () => {
    render(<Chip />);
    expect(screen.getByTestId("count").textContent).toBe("0");
    await act(async () => { await queueWrite("PATCH", "/api/nodes/x", "{}"); });
    expect(screen.getByTestId("count").textContent).toBe("1");
    await act(async () => { await queueWrite("DELETE", "/api/nodes/x", null); });
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("refreshPendingCount re-counts from the local DB (drains may stop mid-list)", async () => {
    act(() => bumpPending(7));
    await act(async () => { await refreshPendingCount(); });
    expect(getPendingCount()).toBe(2); // the mock's queue length wins over arithmetic
  });

  it("never goes negative", () => {
    act(() => bumpPending(-5));
    expect(getPendingCount()).toBe(0);
  });
});

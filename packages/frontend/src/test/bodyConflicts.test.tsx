import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BodyConflictList from "../components/BodyConflictList";
import { findKeptText, resolveBodyConflict, type BodyConflictRegion } from "../lib/bodyConflict";
import type { ContentNode } from "../lib/api";
import type { LiveEvent } from "../lib/liveEvent";

const region: BodyConflictRegion = { base: "買牛奶\n", incoming: "買豆漿\n", current: "買咖啡\n", before: "清單\n", after: "結束\n" };

describe("resolveBodyConflict", () => {
  it("puts the left-out text in place of the kept text, or after it", () => {
    const body = "清單\n買豆漿\n結束\n";
    expect(resolveBodyConflict(body, region, "other")).toBe("清單\n買咖啡\n結束\n");
    expect(resolveBodyConflict(body, region, "both")).toBe("清單\n買豆漿\n買咖啡\n結束\n");
  });

  it("finds the kept text by its neighbours after edits elsewhere", () => {
    const body = "新的開頭\n買豆漿\n\n清單\n買豆漿\n結束\n另一行";
    expect(findKeptText(body, region)).toBe(body.indexOf("清單\n買豆漿") + "清單\n".length);
  });

  it("falls back to a single occurrence when a neighbour changed, and gives up when it is gone or ambiguous", () => {
    expect(resolveBodyConflict("清單（改）\n買豆漿\n結束\n", region, "other")).toBe("清單（改）\n買咖啡\n結束\n");
    expect(resolveBodyConflict("清單\n買豆漿兩瓶\n結束\n", { ...region, incoming: "買豆漿三瓶\n" }, "other")).toBeNull();
    expect(resolveBodyConflict("買豆漿\nx\n買豆漿\n", region, "other")).toBeNull();
  });

  it("handles the body's first and last lines, and kept text that was a deletion", () => {
    const last: BodyConflictRegion = { base: "B", incoming: "B1", current: "B2", before: "A\n", after: "" };
    expect(resolveBodyConflict("A\nB1", last, "both")).toBe("A\nB1\nB2");
    const deleted: BodyConflictRegion = { base: "x\n", incoming: "", current: "x2\n", before: "A\n", after: "C\n" };
    expect(resolveBodyConflict("A\nC\n", deleted, "other")).toBe("A\nx2\nC\n");
    expect(resolveBodyConflict("A\nC\nA\nC\n", deleted, "other")).toBeNull();
  });
});

const event = (id: number, regions: BodyConflictRegion[], truncated = false): LiveEvent => ({
  id, actor_type: "system", actor_id: "u", event_type: "BODY_CONFLICT", target_type: "node", target_id: "n1",
  created_at: "2026-10-18T09:00:00Z",
  payload: { conflicts: regions, conflict_count: truncated ? 3 : regions.length, ...(truncated ? { truncated: true } : {}) },
});
const note = { id: "n1", title: "Shopping" } as ContentNode;

describe("BodyConflictList", () => {
  it("shows the kept and left-out text and dismisses once every place is resolved", async () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    const onDismiss = vi.fn();
    const second = { ...region, incoming: "a\n", current: "b\n" };
    render(<BodyConflictList conflicts={[event(7, [region, second])]} nodes={[note]} onOpenNode={vi.fn()} onResolve={onResolve} onDismiss={onDismiss} />);
    expect(screen.getByText("買豆漿")).toBeInTheDocument();
    expect(screen.getByText("買咖啡")).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Use the left-out text")[0]!);
    await waitFor(() => expect(screen.getByText("Resolved")).toBeInTheDocument());
    expect(onResolve).toHaveBeenCalledWith("n1", region, "other");
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Keep both"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith(7));
    expect(onResolve).toHaveBeenLastCalledWith("n1", second, "both");
  });

  it("a failed resolve stays open; a too-large conflict points to history; no write without a note", async () => {
    const onResolve = vi.fn().mockResolvedValue(false);
    const { rerender } = render(<BodyConflictList conflicts={[event(1, [region])]} nodes={[note]} onOpenNode={vi.fn()} onResolve={onResolve} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByText("Use the left-out text"));
    await waitFor(() => expect(onResolve).toHaveBeenCalled());
    expect(screen.queryByText("Resolved")).toBeNull();
    rerender(<BodyConflictList conflicts={[event(2, [], true)]} nodes={[note]} onOpenNode={vi.fn()} onResolve={onResolve} onDismiss={vi.fn()} />);
    expect(screen.getByText(/note's history/)).toBeInTheDocument();
    rerender(<BodyConflictList conflicts={[event(3, [region])]} nodes={[]} onOpenNode={vi.fn()} onResolve={onResolve} onDismiss={vi.fn()} />);
    expect(screen.queryByText("Use the left-out text")).toBeNull();
  });
});

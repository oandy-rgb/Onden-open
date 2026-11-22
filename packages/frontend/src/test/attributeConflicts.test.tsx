import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook, act } from "@testing-library/react";

const live = vi.hoisted(() => ({ events: [] as unknown[], scope: "acct-A" as string | null }));
vi.mock("../hooks/useLiveEventLog", () => ({ useLiveEventLog: () => ({ events: live.events }) }));
vi.mock("../lib/accountStorage", () => ({
  accountStorageKey: (key: string) => {
    if (live.scope === null) throw new Error("Sign in before opening local account data");
    return `${key}:account-v1:${live.scope}`;
  },
}));

import ConflictList from "../components/ConflictList";
import { useAttributeConflicts } from "../hooks/useAttributeConflicts";
import type { ContentNode } from "../lib/api";
import type { LiveEvent } from "../lib/liveEvent";

const conflict = (id: number, target: string): LiveEvent => ({
  id, actor_type: "user", actor_id: "u", event_type: "ATTRIBUTE_CONFLICT", target_type: "node", target_id: target,
  created_at: "2026-10-14T09:00:00Z",
  payload: { key: "status", incoming_value: "done", overridden_value: "draft", server_updated_at: "", client_updated_at: "" },
});
const note = { id: "n1", title: "Report" } as ContentNode;

beforeEach(() => { sessionStorage.clear(); live.events = [conflict(1, "n1"), conflict(2, "n1")]; live.scope = "acct-A"; });

describe("ConflictList", () => {
  it("shows what was lost and offers Revert and Dismiss", async () => {
    const onRevert = vi.fn(async () => true); const onDismiss = vi.fn(); const onOpenNode = vi.fn();
    render(<ConflictList conflicts={[conflict(1, "n1")]} nodes={[note]} onOpenNode={onOpenNode} onRevert={onRevert} onDismiss={onDismiss} />);
    expect(screen.getByText("draft").tagName).toBe("S");
    fireEvent.click(screen.getByText("Report"));
    expect(onOpenNode).toHaveBeenCalledWith("n1");
    fireEvent.click(screen.getByText(/Revert/));
    // The server reverts by event (its recorded value and type), not a value sent back.
    expect(onRevert).toHaveBeenCalledWith(1, "n1", "status");
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledWith(1));
  });

  it("a revert that was refused keeps the conflict listed", async () => {
    const onRevert = vi.fn(async () => false); const onDismiss = vi.fn();
    render(<ConflictList conflicts={[conflict(1, "n1")]} nodes={[note]} onOpenNode={vi.fn()} onRevert={onRevert} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText(/Revert/));
    await vi.waitFor(() => expect(screen.getByText(/Revert/).closest("button")).toBeEnabled());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("a drawing conflict shows a summary of what both devices changed, never the drawings", () => {
    const ink = (id: number, payload: Record<string, unknown>): LiveEvent =>
      ({ ...conflict(id, "n1"), payload: { key: "ink_data", server_updated_at: "", client_updated_at: "", ...payload } });
    render(<ConflictList nodes={[note]} onOpenNode={vi.fn()} onRevert={vi.fn(async () => true)} onDismiss={vi.fn()} conflicts={[
      ink(1, { incoming_value_ref: "abc", ink_conflicts: [{ kind: "stroke", id: "s1" }, { kind: "stroke", id: "s2" }] }),
      ink(2, { ink_conflicts: [{ kind: "stroke", id: "s1", page: 2 }, { kind: "annotation", id: "h1" }, { kind: "page", page: 2 }] }),
      ink(3, { ink_conflicts: [{ kind: "format" }] }),
      ink(4, {}),
      // A page one device deleted while the other drew on it (kept, reported): counted as a page.
      ink(5, { ink_conflicts: [{ kind: "deletedPage", pageKey: "p2" }, { kind: "stroke", id: "s9", pageKey: "p3" }] }),
    ]} />);
    expect(screen.getByText("2 strokes changed on both devices")).toBeInTheDocument();
    expect(screen.getByText("1 stroke, 1 highlight, page settings changed on both devices")).toBeInTheDocument();
    expect(screen.getByText("Both devices saved a different kind of drawing")).toBeInTheDocument();
    expect(screen.getByText("The drawing changed on both devices")).toBeInTheDocument();
    expect(screen.getByText("1 stroke, 1 page changed on both devices")).toBeInTheDocument();
    expect(screen.queryByText("(empty)")).toBeNull();
    expect(screen.getAllByText(/Revert/)).toHaveLength(5);
  });

  it("a conflict on a deleted note cannot be reverted, and an empty list renders nothing", () => {
    const { container, rerender } = render(<ConflictList conflicts={[conflict(1, "gone")]} nodes={[note]} onOpenNode={vi.fn()} onRevert={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText("(deleted note)")).toBeDisabled();
    expect(screen.queryByText(/Revert/)).toBeNull();
    rerender(<ConflictList conflicts={[]} nodes={[note]} onOpenNode={vi.fn()} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("useAttributeConflicts", () => {
  it("dismissals hide a conflict for this account's session, not another account's", () => {
    const first = renderHook(() => useAttributeConflicts());
    act(() => first.result.current.dismiss(1));
    expect(first.result.current.conflicts.map((e) => e.id)).toEqual([2]);
    first.unmount();
    expect(renderHook(() => useAttributeConflicts()).result.current.conflicts.map((e) => e.id)).toEqual([2]);
    live.scope = "acct-B";
    expect(renderHook(() => useAttributeConflicts()).result.current.conflicts.map((e) => e.id)).toEqual([1, 2]);
  });

  it("works in memory before an account is bound", () => {
    live.scope = null;
    const { result } = renderHook(() => useAttributeConflicts());
    act(() => result.current.dismiss(2));
    expect(result.current.conflicts.map((e) => e.id)).toEqual([1]);
  });
});

// 「系統整理」 row in the History feed: one plain sentence, the notes only when opened, no id or technical word anywhere.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WorkspaceHistorySystemTidy from "../components/history/WorkspaceHistorySystemTidy";
import type { DayTidy } from "@onden/contract";

afterEach(cleanup);
const tidy = (over: Partial<DayTidy> = {}): DayTidy => ({
  batch: "9f1c2b6e-0000-4000-8000-000000000001", at: "2026-11-08T10:00:00.000Z", kind: "marks_moved_out",
  notes: [{ id: "n-1", title: "演算法", space_id: null }, { id: "n-2", title: "", space_id: null }], ...over,
});

describe("WorkspaceHistorySystemTidy", () => {
  it("says what the system did in one sentence, and lists the notes only when opened", () => {
    render(<WorkspaceHistorySystemTidy tidy={tidy()} onOpenNote={() => {}} />);
    expect(screen.getByText(/系統整理了 2 篇筆記的段落標記|tidied the paragraph marks in 2 notes/)).toBeTruthy();
    expect(screen.queryByText("演算法")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /看是哪些筆記|Show which notes/ }));
    expect(screen.getByText("演算法")).toBeTruthy();
    // A note with no title is named, never shown by its id.
    expect(screen.getAllByRole("button").some((b) => /未命名|Untitled/.test(b.textContent ?? ""))).toBe(true);
  });

  it("shows no id, batch, event name or technical word", () => {
    const { container } = render(<WorkspaceHistorySystemTidy tidy={tidy({ kind: "marks_written_back" })} onOpenNote={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /看是哪些筆記|Show which notes/ }));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/n-1|n-2|9f1c2b6e|NODE_UPDATED|conversion|batch|anchor|\^|json/i);
    expect(text).toMatch(/寫回|written the paragraph marks back|wrote the paragraph marks back/);
  });

  it("a note of the list opens that note's history", () => {
    const open = vi.fn();
    render(<WorkspaceHistorySystemTidy tidy={tidy()} onOpenNote={open} />);
    fireEvent.click(screen.getByRole("button", { name: /看是哪些筆記|Show which notes/ }));
    fireEvent.click(screen.getByText("演算法"));
    expect(open).toHaveBeenCalledWith("n-1");
  });
});

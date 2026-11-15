import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CanvasNotePicker from "../components/CanvasNotePicker";
import { ApiError, noWorkspaceData, type Canvas, type ContentNode } from "../lib/api";
import { addToast, getAppState, resetAppState } from "../lib/appStore";
import { reportWriteFailure } from "../lib/data/writeErrors";
import { setLocalePref } from "../lib/i18n";

const note = (id: string, extra = {}) => ({ id, title: id, node_type: "content", ...extra }) as ContentNode;
const board: Canvas = { id: "board", title: "Board", created_at: "", updated_at: "",
  data: { nodes: [{ nodeId: "filtered-out", x: 0, y: 0 }] } };
function deferred() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  setLocalePref("en");
  resetAppState({ activeCanvas: board, data: { ...noWorkspaceData, nodes: [
    note("filtered-out"), note("available"), note("second"), note("board", { node_type: "canvas" }),
    note("hidden", { hidden: true }), note("tag", { node_type: "class_tag" }),
  ] } });
});
afterEach(cleanup);

describe("adding an existing canvas note", () => {
  it("excludes every board member even when graph filters hide it, plus hidden notes, tags and the board itself", () => {
    render(<CanvasNotePicker canvasId="board" onAdd={vi.fn()} onAdded={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "filtered-out" })).toBeNull();
    for (const name of ["hidden", "tag", "board"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "available" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  AVAILABLE  " } });
    expect(screen.queryByRole("button", { name: "second" })).toBeNull();
    expect(screen.getByRole("button", { name: "available" })).toBeTruthy();
  });

  it("searching \"meeting\" lists the note named Meeting even when twelve other notes only hold its letters in order", () => {
    const scattered = Array.from({ length: 12 }, (_, i) => note(`s${i}`, { title: `make every event task item new goal ${i}` }));
    resetAppState({ activeCanvas: board, data: { ...noWorkspaceData, nodes: [...scattered, note("real", { title: "Meeting" })] } });
    render(<CanvasNotePicker canvasId="board" onAdd={vi.fn()} onAdded={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "meeting" } });
    expect(screen.getByRole("button", { name: "Meeting" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /make every event/ })).toBeNull();
  });

  it("waits for acknowledgement before revealing the card, and prevents repeated or concurrent picks", async () => {
    const gate = deferred(); const onAdd = vi.fn(() => gate.promise); const onAdded = vi.fn();
    render(<CanvasNotePicker canvasId="board" onAdd={onAdd} onAdded={onAdded} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "available" }));
    fireEvent.click(screen.getByRole("button", { name: "available" }));
    fireEvent.click(screen.getByRole("button", { name: "second" }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("available");
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Adding…");
    await act(async () => gate.resolve());
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("available");
  });

  it("does not reveal a card the person declined to place at the audience reminder", async () => {
    const onAdd = vi.fn(async () => false); const onAdded = vi.fn();
    render(<CanvasNotePicker canvasId="board" onAdd={onAdd} onAdded={onAdded} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "available" }));
    await act(async () => { await Promise.resolve(); });
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("retains the search after refusal and allows retry without reporting the writer's error twice", async () => {
    const error = new ApiError(403, "denied"); const onAdded = vi.fn();
    const onAdd = vi.fn().mockImplementationOnce(async () => {
      reportWriteFailure(error, addToast); throw error;
    }).mockResolvedValueOnce(undefined);
    render(<CanvasNotePicker canvasId="board" onAdd={onAdd} onAdded={onAdded} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "available" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "available" })));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("available");
    expect(onAdded).not.toHaveBeenCalled();
    expect(getAppState().toasts).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "available" })));
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("available");
  });

  it("does not navigate after the picker was closed or its board was left while saving", async () => {
    const gate = deferred(); const onAdded = vi.fn();
    const { unmount } = render(<CanvasNotePicker canvasId="board" onAdd={() => gate.promise} onAdded={onAdded} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "available" }));
    unmount();
    await act(async () => gate.resolve());
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("closes with a visible button or Escape, including from a result row", () => {
    const onClose = vi.fn();
    render(<CanvasNotePicker canvasId="board" onAdd={vi.fn()} onAdded={vi.fn()} onClose={onClose} />);
    fireEvent(screen.getByRole("dialog", { hidden: true }), new Event("cancel", { cancelable: true }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

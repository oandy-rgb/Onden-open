// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appendToNote = vi.fn();
vi.mock("../modules", async (importOriginal) => ({ ...(await importOriginal<object>()), loadRssQuote: async () => ({ appendToNote: (...args: unknown[]) => appendToNote(...args), appendQuote: vi.fn() }) }));
const toasts: string[] = [];
vi.mock("../lib/appStore", async (importOriginal) => ({ ...(await importOriginal<object>()), addToast: (message: string) => { toasts.push(message); } }));

import { SplitDropHint } from "../components/splitView";
import QuickNote from "../components/splitView/QuickNote";
import { splitDrag } from "../lib/splitViewStore";

afterEach(() => { cleanup(); splitDrag.cancel(); appendToNote.mockReset(); toasts.length = 0; });

describe("the landing shown while dragging", () => {
  it("appears over the right half while something is dragged, and goes on Esc", () => {
    render(<SplitDropHint />);
    expect(screen.queryByText("Drop to open on the right")).toBeNull();
    act(() => splitDrag.begin({ kind: "page", mode: "tasks" }, "function"));
    expect(screen.getByText("Drop to open on the right")).toBeTruthy();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(screen.queryByText("Drop to open on the right")).toBeNull();
  });

  it("highlights only when the pointer is over the right half", () => {
    vi.stubGlobal("innerWidth", 1000);
    const { container } = render(<SplitDropHint />);
    act(() => splitDrag.begin({ kind: "note", id: "n", tab: "content" }, "tab"));
    const landing = () => container.querySelector(".split-drop--right")!;
    expect(landing().hasAttribute("data-active")).toBe(false);
    act(() => { window.dispatchEvent(new MouseEvent("dragover", { clientX: 800 })); });
    expect(landing().hasAttribute("data-active")).toBe(true);
    act(() => { window.dispatchEvent(new MouseEvent("dragover", { clientX: 100 })); });
    expect(landing().hasAttribute("data-active")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("shows the left landing instead when the right pane's own header is dragged", () => {
    const { container } = render(<SplitDropHint />);
    act(() => splitDrag.begin({ kind: "note", id: "n", tab: "content" }, "right-header"));
    expect(container.querySelector(".split-drop--left")).toBeTruthy();
    expect(container.querySelector(".split-drop--right")).toBeNull();
  });
});

describe("記一下", () => {
  it("writes the line into the right note and empties the box once the write is accepted", async () => {
    appendToNote.mockResolvedValue({ status: "synced", undo: vi.fn() });
    render(<QuickNote noteId="n1" />);
    fireEvent.change(screen.getByLabelText("Jot down"), { target: { value: "  remember this  " } });
    fireEvent.submit(screen.getByLabelText("Jot down").closest("form")!);
    await waitFor(() => expect(appendToNote).toHaveBeenCalledWith("n1", "remember this"));
    await waitFor(() => expect((screen.getByLabelText("Jot down") as HTMLInputElement).value).toBe(""));
  });

  it("keeps what was typed when the write fails", async () => {
    appendToNote.mockRejectedValue(new Error("refused"));
    render(<QuickNote noteId="n1" />);
    fireEvent.change(screen.getByLabelText("Jot down"), { target: { value: "keep me" } });
    fireEvent.submit(screen.getByLabelText("Jot down").closest("form")!);
    await waitFor(() => expect(appendToNote).toHaveBeenCalled());
    await waitFor(() => expect(toasts.length).toBe(1));
    expect((screen.getByLabelText("Jot down") as HTMLInputElement).value).toBe("keep me");
  });

  it("says when the line was only saved on this device", async () => {
    appendToNote.mockResolvedValue({ status: "queued", undo: vi.fn() });
    render(<QuickNote noteId="n1" />);
    fireEvent.change(screen.getByLabelText("Jot down"), { target: { value: "offline" } });
    fireEvent.submit(screen.getByLabelText("Jot down").closest("form")!);
    await waitFor(() => expect(toasts.length).toBe(1));
    expect(toasts[0]).toMatch(/device/);
  });

  it("does not send an empty line", () => {
    render(<QuickNote noteId="n1" />);
    fireEvent.submit(screen.getByLabelText("Jot down").closest("form")!);
    expect(appendToNote).not.toHaveBeenCalled();
  });
});

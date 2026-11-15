import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteEditedLine from "../components/NoteEditedLine";
import { setLocalePref } from "../lib/i18n";

const at = new Date(Date.now() - 8 * 86_400_000).toISOString();

beforeEach(() => { act(() => setLocalePref("zh-TW")); });
afterEach(() => { cleanup(); act(() => setLocalePref("system")); });

describe("NoteEditedLine", () => {
  it("makes the whole phrase one link that opens history", () => {
    const open = vi.fn();
    render(<NoteEditedLine updatedAt={at} onOpenHistory={open} />);
    const link = screen.getByRole("button", { name: "8 天前修改，打開這篇筆記的歷史" });
    expect(link.querySelector("time")).toHaveAttribute("datetime", at);
    expect(link.querySelector("time")).toHaveAttribute("title");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith();
  });

  it("is plain text without a way to open history", () => {
    render(<NoteEditedLine updatedAt={at} />);
    expect(screen.getByText("8 天前修改").tagName).toBe("TIME");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("adds 「AI 改過 N 次」 inside the same link, only when an AI made edits", () => {
    const open = vi.fn();
    render(<NoteEditedLine updatedAt={at} onOpenHistory={open} aiEdits={2} />);
    const link = screen.getByRole("button", { name: "8 天前修改，打開這篇筆記的歷史, AI 改過 2 次" });
    expect(link).toHaveTextContent("8 天前修改 · AI 改過 2 次");
    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(1);
    cleanup();
    render(<NoteEditedLine updatedAt={at} onOpenHistory={open} aiEdits={0} />);
    expect(screen.getByRole("button")).not.toHaveTextContent("AI");
  });

  it("says it once for a single edit", () => {
    render(<NoteEditedLine updatedAt={at} aiEdits={1} />);
    expect(screen.getByText("AI 改過 1 次")).toBeInTheDocument();
  });
});

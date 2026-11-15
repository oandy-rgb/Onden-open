import { describe, it, expect, vi } from "vitest";
import { registerNoteEditor, insertIntoNoteEditor } from "../lib/editorInsert";

describe("insert at the open editor's caret", () => {
  it("reaches only the open note's editor, and stops after it closes", () => {
    const insert = vi.fn();
    const unregister = registerNoteEditor("note-a", insert);
    expect(insertIntoNoteEditor("note-b", "[@x]")).toBe(false);
    expect(insertIntoNoteEditor("note-a", "[@x]")).toBe(true);
    expect(insert).toHaveBeenCalledWith("[@x]", undefined);
    unregister();
    expect(insertIntoNoteEditor("note-a", "[@y]")).toBe(false);
  });

  it("a stale unregister does not remove the editor that replaced it", () => {
    const first = registerNoteEditor("note-a", vi.fn());
    const second = vi.fn();
    registerNoteEditor("note-b", second);
    first();
    expect(insertIntoNoteEditor("note-b", "t")).toBe(true);
    expect(second).toHaveBeenCalledWith("t", undefined);
  });

  it("passes on that the text goes at the end when the writer never put the caret in the text", () => {
    const insert = vi.fn();
    const off = registerNoteEditor("note-a", insert);
    insertIntoNoteEditor("note-a", "答案", { endIfNoCaret: true });
    expect(insert).toHaveBeenCalledWith("答案", { endIfNoCaret: true });
    off();
  });
});

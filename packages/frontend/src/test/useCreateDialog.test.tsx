// Smoke test for useCreateDialog — verify Day 4 hook extraction
// preserves expected state defaults + setter behaviour.

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCreateDialog } from "../hooks/useCreateDialog";

describe("useCreateDialog", () => {
  it("starts with sane defaults", () => {
    const { result } = renderHook(() => useCreateDialog());
    expect(result.current.createOpen).toBe(false);
    expect(result.current.eventsOpen).toBe(false);
    expect(result.current.draftTitle).toBe("New Markdown Node");
    expect(result.current.taskTitle).toBe("");
  });

  it("setters update independent state slots", () => {
    const { result } = renderHook(() => useCreateDialog());

    act(() => {
      result.current.setCreateOpen(true);
      result.current.setDraftTitle("My Note");
    });

    expect(result.current.createOpen).toBe(true);
    expect(result.current.draftTitle).toBe("My Note");
    // Unrelated slots remain at default
    expect(result.current.taskTitle).toBe("");
  });

  it("toggling eventsOpen doesn't affect createOpen", () => {
    const { result } = renderHook(() => useCreateDialog());
    act(() => { result.current.setEventsOpen(true); });
    expect(result.current.eventsOpen).toBe(true);
    expect(result.current.createOpen).toBe(false);
  });
});

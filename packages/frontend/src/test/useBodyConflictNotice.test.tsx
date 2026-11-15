// A same-words conflict tells the tab whose text lost, once, in plain words;
// the winning tab and tabs that never saved the note hear nothing here.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

type Ev = { id: number; target_id: string; payload: Record<string, unknown> };
const live = vi.hoisted(() => ({ events: [] as Ev[] }));
vi.mock("../hooks/useLiveEventLog", () => ({ useLiveEventLog: () => ({ events: live.events }) }));
const addToast = vi.hoisted(() => vi.fn());
vi.mock("../lib/appStore", async (original) => ({ ...await original<typeof import("../lib/appStore")>(), addToast }));
const owned = vi.hoisted(() => ({ body: undefined as string | undefined }));
vi.mock("../lib/data", () => ({ drafts: { acceptedBody: () => owned.body } }));

import { useBodyConflictNotice } from "../hooks/useBodyConflictNotice";
import { leftOutOwnText } from "../lib/bodyConflict";

const region = (incoming: string, current: string) => ({ base: "x\n", incoming, current, before: "", after: "" });
const conflict = (id: number, incoming: string, current: string): Ev =>
  ({ id, target_id: "n1", payload: { conflicts: [region(incoming, current)], conflict_count: 1 } });

beforeEach(() => { addToast.mockReset(); live.events = []; owned.body = undefined; });

describe("leftOutOwnText", () => {
  it("is true when the left-out side is text this tab saved", () => {
    const payload = { conflicts: [region("B\n", "A\n")], conflict_count: 1 };
    expect(leftOutOwnText("head\nA\ntail", payload)).toBe(true);
    expect(leftOutOwnText("head\nB\ntail", payload)).toBe(false);
    expect(leftOutOwnText(undefined, payload)).toBe(false);
  });
  it("counts a payload too large for regions when the tab saved the note", () => {
    expect(leftOutOwnText("x", { conflicts: [], conflict_count: 3, truncated: true })).toBe(true);
    expect(leftOutOwnText(undefined, { conflicts: [], conflict_count: 3, truncated: true })).toBe(false);
  });
});

describe("useBodyConflictNotice", () => {
  it("skips history, then tells the tab whose saved text lost, once", () => {
    live.events = [conflict(5, "B\n", "A\n")];
    owned.body = "A\n";
    const { rerender } = renderHook(() => useBodyConflictNotice());
    expect(addToast).not.toHaveBeenCalled();

    live.events = [conflict(6, "Y\n", "A\n"), conflict(5, "B\n", "A\n")];
    rerender();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![0]).toBe("Someone changed the same text at the same time. Your version is saved in the note's history.");
    rerender();
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for the tab whose text won", () => {
    live.events = [conflict(1, "B\n", "A\n")];
    owned.body = "B\n";
    const { rerender } = renderHook(() => useBodyConflictNotice());
    live.events = [conflict(2, "B\n", "A\n"), conflict(1, "B\n", "A\n")];
    rerender();
    expect(addToast).not.toHaveBeenCalled();
  });
});

// NOTIFICATION events become toasts: the first batch is history (no toasts),
// later events toast once each, oldest first, with the level mapped.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

type Ev = { id: number; payload?: Record<string, unknown> };
const live = vi.hoisted(() => ({ events: [] as Ev[] }));
vi.mock("../hooks/useLiveEventLog", () => ({ useLiveEventLog: () => ({ events: live.events }) }));
const addToast = vi.hoisted(() => vi.fn());
vi.mock("../lib/appStore", async (original) => ({ ...await original<typeof import("../lib/appStore")>(), addToast }));

import { useNotificationToasts } from "../hooks/useNotificationToasts";

beforeEach(() => { addToast.mockReset(); live.events = []; });

describe("useNotificationToasts", () => {
  it("skips the first batch, then toasts new events oldest first", () => {
    live.events = [{ id: 5, payload: { message: "old" } }];
    const { rerender } = renderHook(() => useNotificationToasts());
    expect(addToast).not.toHaveBeenCalled();

    live.events = [
      { id: 8, payload: { message: "third", level: "warning" } },
      { id: 7, payload: { message: "second", level: "success", via_tag_name: "lab" } },
      { id: 6, payload: { message: "first" } },
      { id: 5, payload: { message: "old" } },
    ];
    rerender();
    expect(addToast.mock.calls).toEqual([
      ["first", "info"],
      ["second (via #lab)", "success"],
      ["third", "error"],
    ]);

    rerender();
    expect(addToast).toHaveBeenCalledTimes(3);
  });
});

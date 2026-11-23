// Review of PR #1958 (property 3): when this device cannot keep a stroke at pen-up (storage full, a private window), the
// person is told in the words and place the app already uses for "this device could not save its copy" (DeviceNotices,
// with its retry), not silently; the stroke still goes with the surface's save as before.
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  addPendingWrite: vi.fn(async () => { throw new Error("QuotaExceededError"); }),
  replacePendingWrite: vi.fn(async () => { throw new Error("QuotaExceededError"); }),
  getPendingWrites: vi.fn(async () => []),
}));

import { keepUnsentWrite } from "../lib/data/writeQueue";
import { setLocalCopyUnavailable, useLocalCopyUnavailable } from "../lib/localCopyStatus";

afterEach(() => { setLocalCopyUnavailable(false); });

describe("a stroke this device could not keep", () => {
  it("raises the device notice once the row could not be stored, and again when a rewrite fails", async () => {
    const notice = renderHook(() => useLocalCopyUnavailable());
    expect(notice.result.current).toBe(false);
    const kept = keepUnsentWrite({ method: "PUT", path: "/api/nodes/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b/attributes/ink_data", body: "{}" });
    expect(await kept.recorded).toBe(false);
    await waitFor(() => expect(notice.result.current).toBe(true));
    setLocalCopyUnavailable(false);
    expect(await kept.rewrite({ method: "PUT", path: "/api/nodes/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b/attributes/ink_data", body: "{\"value\":\"x\"}" })).toBe(false);
    await waitFor(() => expect(notice.result.current).toBe(true));
    await kept.drop();
  });
});

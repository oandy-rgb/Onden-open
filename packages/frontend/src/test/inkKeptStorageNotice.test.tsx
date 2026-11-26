// Review of PR #1958 (property 3): when this device cannot keep a stroke at pen-up (storage full, a private window), the
// person is told in the words and place the app already uses for "this device could not save its copy" (DeviceNotices,
// with its retry), not silently; the stroke still goes with the surface's save as before.
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/** `refuse`: the queue's storage refuses every row; `stuck`: it never answers (a busy or wedged worker). */
const { queue, answer } = vi.hoisted(() => {
  // Stuck writes are let go (as refusals) after each test: the queue's rows are written one after another, and a write
  // left hanging would hold up every later test's (the tests run in a shuffled order).
  const queue = { mode: "refuse" as "refuse" | "stuck", stuck: [] as Array<() => void> };
  const answer = async () => {
    if (queue.mode === "stuck") return new Promise<void>((_, reject) => { queue.stuck.push(() => reject(new Error("let go"))); });
    throw new Error("QuotaExceededError");
  };
  return { queue, answer };
});
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  addPendingWrite: vi.fn(answer),
  replacePendingWrite: vi.fn(answer),
  getPendingWrites: vi.fn(async () => []),
  getRejectedWrites: vi.fn(async () => []),
}));

import { keepUnsentWrite } from "../lib/data/writeQueue";
import { setLocalCopyUnavailable, useLocalCopyUnavailable } from "../lib/localCopyStatus";
import { bindAccountStorage } from "../lib/accountStorage";

// Copies are account-scoped: an unbound page could keep none, and every test below would pass for that reason alone.
bindAccountStorage("kept-storage-notice", "http://localhost");

afterEach(async () => {
  queue.mode = "refuse";
  for (const letGo of queue.stuck.splice(0)) letGo();
  await new Promise((resolve) => setTimeout(resolve, 0));
  localStorage.clear();
  setLocalCopyUnavailable(false);
});
const PATH = "/api/nodes/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b/attributes/ink_data";

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

// Review of PR #1958 round 2 (item 2): neither layer may fail silently. The copy at pen-up refused (localStorage full)
// while the queue row is only slow, never refused: the person is told in the pen-up handler itself, not when (if ever)
// the row fails.
describe("a stroke neither the copy nor the queue holds yet", () => {
  // The queue here never answers (stuck, not refused), so only a refused copy can raise the notice. The copy is refused
  // the way a full device refuses it, by the copies' own cap (the test DOM has no storage quota to fill).
  it("raises the device notice when a copy is refused while the queue row is stuck (copies at their cap)", async () => {
    queue.mode = "stuck";
    const notice = renderHook(() => useLocalCopyUnavailable());
    const big = (i: number) => JSON.stringify({ value: `${i}`.padEnd(450_000, "x"), base_value: "" });
    for (let i = 0; i < 3; i++) keepUnsentWrite({ method: "PUT", path: PATH, body: big(i) });
    expect(notice.result.current, "three copies of 450 KB are within the cap").toBe(false);
    keepUnsentWrite({ method: "PUT", path: PATH, body: big(3) });
    await waitFor(() => expect(notice.result.current, "the fourth would pass 1,500,000 characters").toBe(true));
    const held = Object.keys(localStorage).filter((key) => key.includes("keptWrites"));
    expect(held, "the refused copy was not stored").toHaveLength(3);
  });
});

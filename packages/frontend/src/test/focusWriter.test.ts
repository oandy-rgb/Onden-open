// What focus writes send: the id is minted by the caller (a resend finds the
// same record), a time travels while offline, or when it is more than two minutes behind (otherwise the server stamps
// "now", so a device clock a minute ahead is never refused), and a sentence
// is sent only with the places it was asked to go.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "./helpers/propsConfig";

const submitWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/writeQueue", async (original) => ({ ...await original<typeof import("../lib/data/writeQueue")>(), submitWrite }));

import { makeFocusWriter } from "../lib/data/focusWriter";

const writer = (online: boolean) => makeFocusWriter({ online, addToast: vi.fn(), setData: vi.fn(), data: {} } as never);
const sent = () => {
  const request = submitWrite.mock.calls[0]![0];
  return { ...request, body: JSON.parse(request.body) };
};
const STARTED = "2026-10-31T09:00:00.000Z";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(STARTED) + 30_000); submitWrite.mockReset().mockResolvedValue({ status: "queued" }); });
afterEach(() => { vi.useRealTimers(); });

describe("focusWriter", () => {
  it("begins with the minted id, as its own idempotency key; the time only while offline", async () => {
    await writer(true).start({ id: "11111111-1111-4111-8111-111111111111", taskId: "t1", startedAt: STARTED });
    expect(sent()).toMatchObject({ method: "POST", path: "/api/tasks/focus", idemKey: "11111111-1111-4111-8111-111111111111", body: { id: "11111111-1111-4111-8111-111111111111", task_id: "t1" } });
    expect(sent().body).not.toHaveProperty("started_at");
    submitWrite.mockClear();
    await writer(false).start({ id: "22222222-2222-4222-8222-222222222222", taskId: null, startedAt: STARTED });
    expect(sent().body).toEqual({ id: "22222222-2222-4222-8222-222222222222", started_at: STARTED });
  });

  it("ends with the sentence and the places it was asked to go; no sentence, no places", async () => {
    await writer(true).end("f1", { endedAt: STARTED, note: "  寫完第二段 ", toDiary: true, toTask: false, attemptKey: "k1" });
    expect(sent()).toMatchObject({ path: "/api/tasks/focus/f1/end", idemKey: "k1", body: { note: "寫完第二段", to_diary: true } });
    expect(sent().body).not.toHaveProperty("to_task");
    expect(sent().body).not.toHaveProperty("ended_at");
    submitWrite.mockClear();
    await writer(false).end("f1", { endedAt: STARTED, note: "   ", toDiary: true, toTask: true });
    expect(sent().body).toEqual({ ended_at: STARTED });
  });

  // Scan 10 #9: "time is up at 25 minutes", the sentence is sent 40 minutes later: the record is 25 minutes, not 65.
  it("online, an end that is well behind now is sent as it was; a fresh one is left to the server", async () => {
    vi.setSystemTime(Date.parse(STARTED) + 40 * 60_000);
    await writer(true).end("f1", { endedAt: STARTED, note: "寫完", toDiary: false, toTask: false });
    expect(sent().body).toMatchObject({ ended_at: STARTED });
  });

  it("random lag: the end is sent unless online, not a cycle's, and at most two minutes ago", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3 * 3_600_000 }), fc.boolean(), fc.boolean(), async (lagMs, online, fixedEnd) => {
      submitWrite.mockClear();
      vi.setSystemTime(Date.parse(STARTED) + lagMs);
      await writer(online).end("f1", { endedAt: STARTED, note: "x", toDiary: false, toTask: false, ...(fixedEnd ? { fixedEnd } : {}) });
      const hasEnd = Object.hasOwn(sent().body, "ended_at");
      expect(hasEnd).toBe(!online || fixedEnd || lagMs > 2 * 60_000);
    }), { numRuns: PROPS_RUNS, seed: PROPS_SEED });
  });
});

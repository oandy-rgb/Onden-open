// lib/data/writePositions.ts — the page's door for every answer that carries rows (takeAnswer), its copy of the
// watermark, the write gate that keeps sync alive while the person writes without pause, and the "server lost what it
// went back" outcome (serverWentBack). The local copy here answers as the worker does (its own watermark, the same isCurrentAnswer).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_POSITION_HEADER } from "@onden/markdown/contract";
import { higherPosition, isCurrentAnswer, STALE_ANSWERS_BEFORE_WRITES_WAIT } from "../lib/answerPositions";

const hooks = vi.hoisted(() => ({
  listener: null as null | ((path: string, init: RequestInit | undefined, response: Response) => void),
  gate: null as null | ((path: string, init: RequestInit | undefined) => (() => void) | Promise<() => void>),
  copy: { watermark: null as string | null, cursor: 0, rewound: [] as string[] },
}));
vi.mock("../lib/api", () => ({
  setWriteResponseListener: (listener: typeof hooks.listener) => { hooks.listener = listener; },
  setWriteGate: (gate: typeof hooks.gate) => { hooks.gate = gate; },
}));
vi.mock("../lib/localDb", () => ({
  raiseWatermark: async (position: string) => { hooks.copy.watermark = higherPosition(hooks.copy.watermark, position); },
  rewindCursor: async (to: string) => { hooks.copy.rewound.push(to); },
}));

const { takeAnswer, forgetWatermark, askedNow, serverWentBack, syncPassEnded, syncLoopStarted, startWatermarkFrom, pageWouldTake } = await import("../lib/data/writePositions");
type Asked = ReturnType<typeof askedNow>;

const ack = (position: number) =>
  hooks.listener!("/api/nodes/n1", { method: "PATCH" }, new Response(null, { headers: { [EVENT_POSITION_HEADER]: String(position) } }));
/** An answer read at `head`, through the page and a copy that judges by its own watermark. */
const deliver = (head: number, { serverId = "s1", asked = undefined as Asked | undefined, whileCopyWorks = () => {} } = {}) => {
  const stored: number[] = [];
  return takeAnswer({
    head: String(head), serverId, rewindTo: 0, ...(asked ? { asked } : {}),
    toCopy: async () => {
      const current = isCurrentAnswer(String(head), hooks.copy.watermark);
      whileCopyWorks();
      if (current) hooks.copy.watermark = higherPosition(hooks.copy.watermark, String(head));
      return { value: head, stale: !current, copy: { answer_watermark: hooks.copy.watermark } };
    },
    toStore: (value) => { stored.push(value); },
  }).then((outcome) => ({ outcome, stored }));
};

beforeEach(() => {
  forgetWatermark();
  syncPassEnded();
  hooks.copy = { watermark: null, cursor: 0, rewound: [] };
});

describe("the page's door", () => {
  it("refuses an answer read before an acknowledged write, in the page and in the copy", async () => {
    await deliver(10);
    ack(12);
    expect(hooks.copy.watermark).toBe("12");
    expect(await deliver(11)).toEqual({ outcome: "stale", stored: [] });
    expect(await deliver(12)).toEqual({ outcome: "taken", stored: [12] });
  });

  it("the copy busy: the acknowledgement lands while the copy applies the old answer; the store does not take it and the copy's cursor goes back", async () => {
    await deliver(10);
    const result = await deliver(11, { whileCopyWorks: () => { hooks.copy.watermark = "11"; ack(12); hooks.copy.watermark = "11"; } });
    expect(result).toEqual({ outcome: "stale", stored: [] });
    expect(hooks.copy.rewound).toEqual(["0"]);
  });

  it("an older answer arriving after a newer one is refused", async () => {
    await deliver(20);
    expect((await deliver(18)).outcome).toBe("stale");
  });

  it("another server identity is another log: answered `changed`, and the watermark starts over", async () => {
    await deliver(10);
    ack(5000);
    expect((await deliver(40, { serverId: "s2" })).outcome).toBe("changed");
    expect(pageWouldTake("40", "s2")).toBe(true);
  });

  it("a device with no local copy: the page's watermark alone decides (a bootstrap is just another answer)", async () => {
    startWatermarkFrom({ position: null, server: "s1" });
    ack(12);
    const noCopy = (head: number) => takeAnswer({ head: String(head), serverId: "s1", wholeState: true,
      toCopy: async () => ({ value: head }), toStore: () => {} });
    expect(await noCopy(11)).toBe("stale");
    expect(await noCopy(12)).toBe("taken");
  });

  it("one answer read below what this device knew when its request left (same identity): the server went back", async () => {
    await deliver(10);
    ack(12);
    const asked = askedNow(); // knew 12 when it left
    expect(await deliver(10, { asked })).toEqual({ outcome: "lost", stored: [] });
  });

  it("an answer merely late (known when it left ≤ its head < the watermark now) is only refused, whatever acknowledges meanwhile", async () => {
    await deliver(10);
    const asked = askedNow(); // knew 10
    ack(20); // a write sent after it, acknowledged before its answer
    expect((await deliver(15, { asked })).outcome).toBe("stale");
    expect((await deliver(10, { asked })).outcome).toBe("stale");
    expect(pageWouldTake("19", "s1")).toBe(false); // the watermark is still there
  });

  it("a newer head learnt while a request was on its way (another writer, a single note read taken first) does not make it lost", async () => {
    await deliver(10);
    const asked = askedNow(); // S leaves at 10; the server reads it at 10
    expect((await deliver(12)).outcome).toBe("taken"); // another answer read after another writer's commit, taken first
    expect((await deliver(10, { asked })).outcome).toBe("stale");
  });

  it("the copy's watermark (another tab's acknowledgements) counts once learnt: the next request is judged against it", async () => {
    await deliver(10);
    hooks.copy.watermark = "30"; // tab A was acknowledged at 30; this page saw none of it
    const first = askedNow();
    expect((await deliver(20, { asked: first })).outcome).toBe("stale"); // refused by the copy: its watermark is learnt
    expect((await deliver(20, { asked: askedNow() })).outcome).toBe("lost");
  });

  it("a request's cursor counts as known (it came from a taken answer): cursor past the head is the same rule", () => {
    expect(serverWentBack("120", "s1", askedNow(9000))).toBe(true);
    expect(serverWentBack("9000", "s1", askedNow(9000))).toBe(false);
  });

  it("no proof: another identity, no head, no known position, or the watermark started over since the request left", () => {
    startWatermarkFrom({ position: "50", server: "s1" });
    const asked = askedNow();
    expect(serverWentBack("40", "s2", asked)).toBe(false);
    expect(serverWentBack(undefined, "s1", asked)).toBe(false);
    expect(serverWentBack("40", "s1", { position: null, era: asked.era })).toBe(false);
    expect(serverWentBack("40", undefined, asked)).toBe(true); // an answer that names no identity counts in this one
    forgetWatermark();
    expect(serverWentBack("40", "s1", asked)).toBe(false);
  });
});

describe("liveness: sync keeps up with a person writing every second", () => {
  it("refusals outside a sync pass (a bootstrap, a single note read) never hold a write: nothing could release it", async () => {
    await deliver(10);
    for (let i = 0; i < 5; i++) { ack(20 + i); await deliver(10 + i); }
    let left = false;
    void Promise.resolve(hooks.gate!("/api/nodes/n1", { method: "PATCH" })).then((release) => { left = true; release(); });
    await Promise.resolve(); await Promise.resolve();
    expect(left).toBe(true);
  });

  // A model clock in ticks. The person sends a write every tick; a write is answered (acknowledged) LATENCY ticks
  // after it leaves; a sync request is read by the server when it leaves and answered LATENCY ticks later; another
  // device changes something at tick 0. Writes go through the real gate, answers through the real door.
  async function run(writesWait: boolean): Promise<number | null> {
    const LATENCY = 3;
    let head = 0;
    const otherDeviceAt = ++head; // the change we wait to see is already committed
    let seenAt: number | null = null;
    // A write commits one tick after it leaves (its position is the head then) and is acknowledged LATENCY ticks after.
    const writes: Array<{ commitAt: number; ackAt: number; position: number | null; release: () => void }> = [];
    let request: { readAt: number; answerAt: number } | null = null;
    let leaving = false;
    const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    syncLoopStarted(); // the model is one long sync pass
    for (let tick = 1; tick <= 200 && seenAt === null; tick++) {
      for (const w of writes) if (w.commitAt === tick) w.position = ++head;
      for (const w of writes.filter((x) => x.ackAt === tick)) { w.release(); ack(w.position!); }
      if (request && request.answerAt === tick) {
        const { outcome } = await deliver(request.readAt);
        request = null;
        if (outcome === "taken") seenAt = tick;
      }
      if (!request) request = { readAt: head, answerAt: tick + LATENCY };
      if (!leaving) {
        leaving = true;
        const at = tick;
        void Promise.resolve(writesWait ? hooks.gate!("/api/nodes/n1", { method: "PATCH" }) : () => {}).then((release) => {
          writes.push({ commitAt: Math.max(at, tick) + 1, ackAt: Math.max(at, tick) + LATENCY, position: null, release });
          leaving = false;
        });
      }
      await flush();
    }
    for (const w of writes) w.release(); // the writes still on their way when the model stops
    syncPassEnded();
    await flush();
    expect(otherDeviceAt).toBe(1);
    return seenAt;
  }

  it(`with the gate, another device's change is shown within a bound; without it, never (${STALE_ANSWERS_BEFORE_WRITES_WAIT} refusals hold the next write)`, async () => {
    const withGate = await run(true);
    forgetWatermark(); syncPassEnded(); hooks.copy = { watermark: null, cursor: 0, rewound: [] };
    // The same person against a page whose writes never wait: every answer is overtaken by an acknowledgement.
    const original = hooks.gate;
    hooks.gate = null;
    const withoutGate = await run(false);
    hooks.gate = original;
    expect(withoutGate).toBeNull();
    expect(withGate).not.toBeNull();
    // Bound: the requests refused before the gate holds writes, plus one whose writes were already on their way, plus the
    // one that is taken — each LATENCY ticks.
    expect(withGate!).toBeLessThanOrEqual((STALE_ANSWERS_BEFORE_WRITES_WAIT + 2) * 3 + 1);
  });

  it("a keepalive write (the page is closing) never waits", async () => {
    syncLoopStarted();
    await deliver(10);
    for (let i = 0; i < STALE_ANSWERS_BEFORE_WRITES_WAIT; i++) { ack(20 + i); await deliver(10 + i); }
    let left = false;
    const releases: Array<() => void> = [];
    void Promise.resolve(hooks.gate!("/api/nodes/n1", { method: "PATCH", keepalive: true })).then((release) => { releases.push(release); left = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(left).toBe(true);
    let held = true;
    void Promise.resolve(hooks.gate!("/api/nodes/n1", { method: "PATCH" })).then((release) => { releases.push(release); held = false; });
    await Promise.resolve(); await Promise.resolve();
    expect(held).toBe(true);
    syncPassEnded();
    await Promise.resolve(); await Promise.resolve();
    expect(held).toBe(false);
    for (const release of releases) release(); // answered
  });
});

// The browser worker's one queue (src/browser/queue.ts): nothing overlaps, order is kept, a failure does not stop the line.
import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../browser/queue.js";
import { createContextSlot, createSerialContextProvider, useContextProvider } from "../requestContext.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("serial queue", () => {
  it("runs jobs one at a time, in the order they were queued", async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    let running = 0;
    let overlapped = false;
    const job = (name: string, ms: number) => queue.run(async () => {
      running++;
      overlapped ||= running > 1;
      log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`end ${name}`);
      running--;
      return name;
    });
    const results = await Promise.all([job("a", 15), job("b", 1), job("c", 5)]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(overlapped).toBe(false);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("goes on after a job fails, and the failure reaches only its own caller", async () => {
    const queue = createSerialQueue();
    const failing = queue.run(async () => { throw new Error("boom"); });
    const after = queue.run(async () => "still running");
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("still running");
  });

  it("runNext goes ahead of the jobs still waiting, never ahead of the one running", async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    const first = queue.run(async () => { log.push("first"); await tick(); });
    const second = queue.run(async () => { log.push("second"); });
    const urgent = queue.runNext(async () => { log.push("urgent"); });
    await Promise.all([first, second, urgent]);
    expect(log).toEqual(["first", "urgent", "second"]);
  });

  it("keeps the serial request context right because flows never overlap", async () => {
    // The stack provider is only correct when the host never overlaps flows (portable-backend.md §3): the queue is that guarantee.
    useContextProvider(createSerialContextProvider());
    const slot = createContextSlot<string>();
    const queue = createSerialQueue();
    const seen: Array<string | undefined> = [];
    const flow = (name: string) => queue.run(() => slot.run(name, async () => {
      await tick();
      seen.push(slot.getStore());
      await tick();
      seen.push(slot.getStore());
    }));
    await Promise.all([flow("request"), flow("job")]);
    expect(seen).toEqual(["request", "request", "job", "job"]);
    expect(slot.getStore()).toBeUndefined();
  });
});

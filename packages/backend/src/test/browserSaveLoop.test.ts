// When the browser worker writes a copy of its database (src/browser/saveLoop.ts), with fake time and a fake store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeSaveState } from "@onden/markdown";
import { createSerialQueue } from "../browser/queue.js";
import { createSaveLoop, IDLE_BEFORE_SAVE_MS, MAX_UNSAVED_CHANGES, MAX_UNSAVED_MS } from "../browser/saveLoop.js";
import type { SnapshotStore } from "../browser/snapshotStore.js";

function setup(options: { kind?: SnapshotStore["kind"]; writeFails?: () => boolean; hold?: () => Promise<void> } = {}) {
  let mark = 1;
  const writes: Blob[] = [];
  const states: BridgeSaveState[] = [];
  let copies = 0;
  const store: SnapshotStore = {
    kind: options.kind ?? "opfs",
    copyFormat: "none",
    read: async () => undefined,
    write: async (copy, _meta) => { await options.hold?.(); if (options.writeFails?.()) throw new Error("full"); writes.push(copy); },
    clear: async () => {},
  };
  const queue = createSerialQueue();
  const loop = createSaveLoop({
    queue,
    store,
    copy: async (_format) => { copies++; return new Blob([`copy-${writes.length + 1}`]); },
    writeMark: async () => String(mark),
    report: (state) => states.push(state),
    meta: () => ({ journalSeq: writes.length, schema: "x" }),
  });
  return { loop, queue, writes, states, write: () => { mark++; }, mark: () => mark, copies: () => copies };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("save loop", () => {
  it("saves a moment after the last change, not before", async () => {
    const t = setup();
    await t.loop.afterJob(); // the first look only learns the starting mark
    t.write();
    await t.loop.afterJob();
    expect(t.loop.state().unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_SAVE_MS - 1);
    expect(t.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(t.writes).toHaveLength(1);
    expect(t.loop.state()).toMatchObject({ unsaved: false, failed: false, store: "opfs" });
    expect(t.loop.state().lastSavedAt).not.toBeNull();
  });

  it("after stop() nothing is written, and a copy being written finishes first (start over must not be undone by a late save)", async () => {
    let release!: () => void;
    const t = setup({ hold: () => new Promise<void>((resolve) => { release = resolve; }) });
    await t.loop.afterJob();
    t.write();
    await t.loop.afterJob();
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_SAVE_MS + 10); // the copy is being written, held by the store
    let stopped = false;
    const stopping = t.loop.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(stopped).toBe(false); // waits for the write in flight
    release();
    await stopping;
    expect(t.writes).toHaveLength(1);
    t.write();
    await t.loop.afterJob();
    t.loop.markUnsaved();
    await vi.advanceTimersByTimeAsync(MAX_UNSAVED_MS + 1_000);
    expect(t.writes).toHaveLength(1); // later changes are not saved
  });

  it("markUnsaved makes a copy due even though the write mark did not move (a first open)", async () => {
    const t = setup();
    await t.loop.afterJob();
    t.loop.markUnsaved();
    expect(t.loop.state().unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_SAVE_MS + 10);
    expect(t.writes).toHaveLength(1);
    expect(t.loop.state().unsaved).toBe(false);
  });

  it("does not write a copy when nothing was written to the database", async () => {
    const t = setup();
    await t.loop.afterJob();
    await t.loop.afterJob();
    await vi.advanceTimersByTimeAsync(MAX_UNSAVED_MS * 2);
    expect(t.writes).toHaveLength(0);
    expect(t.loop.state().unsaved).toBe(false);
  });

  it("keeps typing from postponing the save for ever: at most MAX_UNSAVED_MS of changes are unsaved", async () => {
    const t = setup();
    await t.loop.afterJob();
    for (let elapsed = 0; elapsed < MAX_UNSAVED_MS + 1_000; elapsed += 1_000) {
      t.write();
      await t.loop.afterJob();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(t.writes.length).toBeGreaterThanOrEqual(1);
  });

  it("a copy is not made to wait behind a backlog of requests: the timer's save goes ahead of the waiting jobs", async () => {
    const t = setup();
    await t.loop.afterJob();
    let release!: () => void;
    const backlog: Array<Promise<void>> = [];
    // One request is running and 50 more are waiting, as when a script sends them without waiting for answers.
    backlog.push(t.queue.run(() => new Promise<void>((resolve) => { release = resolve; })));
    for (let i = 0; i < 50; i++) backlog.push(t.queue.run(async () => { t.write(); await t.loop.afterJob(); await new Promise((r) => setTimeout(r, 400)); }));
    t.write();
    await t.loop.afterJob();
    release();
    // 50 waiting jobs of 400 ms each are 20 s of work; the copy (due after MAX_UNSAVED_MS) must not wait for the last of them.
    await vi.advanceTimersByTimeAsync(MAX_UNSAVED_MS + 1_000);
    expect(t.writes.length).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(backlog);
  });

  it("with writes that never pause, the last copy is never older than MAX_UNSAVED_MS plus one request and one copy", async () => {
    const t = setup();
    await t.loop.afterJob();
    const saveTimes: number[] = [Date.now()]; // a gap is measured from the moment the writes start
    let stop = false;
    const lane = async () => { while (!stop) { await t.queue.run(async () => { t.write(); await t.loop.afterJob(); await new Promise((r) => setTimeout(r, 300)); }); } };
    const lanes = Array.from({ length: 100 }, lane); // 100 requests always waiting
    for (let elapsed = 0; elapsed < 60_000; elapsed += 500) {
      await vi.advanceTimersByTimeAsync(500);
      if (t.loop.state().lastSavedAt !== null && saveTimes[saveTimes.length - 1] !== t.loop.state().lastSavedAt) saveTimes.push(t.loop.state().lastSavedAt!);
    }
    stop = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(lanes);
    expect(saveTimes.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < saveTimes.length; i++) expect(saveTimes[i] - saveTimes[i - 1]).toBeLessThanOrEqual(MAX_UNSAVED_MS + 1_000);
  });

  it("with a write every 200 ms and a copy that takes 800 ms, copies come about every MAX_UNSAVED_MS, not back to back and not rarer", async () => {
    const t = setup({ hold: () => new Promise<void>((resolve) => { setTimeout(resolve, 800); }) });
    await t.loop.afterJob();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 200) {
      t.write();
      await t.queue.run(() => t.loop.afterJob());
      await vi.advanceTimersByTimeAsync(200);
    }
    // 60 s: one copy per ~10.8 s is 5; many more would be the loop copying all the time, fewer would be a gap above the limit.
    expect(t.writes.length).toBeGreaterThanOrEqual(5);
    expect(t.writes.length).toBeLessThanOrEqual(7);
  });

  it("makes a copy once MAX_UNSAVED_CHANGES changes are not in one, long before the time limit (the log a reopen must replay stays short)", async () => {
    const t = setup();
    await t.loop.afterJob();
    for (let i = 0; i < MAX_UNSAVED_CHANGES + 1; i++) { t.write(); await t.loop.afterJob(); }
    await vi.advanceTimersByTimeAsync(0);
    expect(t.writes).toHaveLength(1);
  });

  it("a store that refuses is not asked for a whole copy after every change past the limit: once per MAX_UNSAVED_CHANGES, and a moment after the next change", async () => {
    const t = setup({ writeFails: () => true });
    await t.loop.afterJob();
    for (let i = 0; i < MAX_UNSAVED_CHANGES * 3; i++) { t.write(); await t.loop.afterJob(); await vi.advanceTimersByTimeAsync(0); }
    expect(t.copies()).toBe(3);
    expect(t.loop.state()).toMatchObject({ unsaved: true, failed: true });
    t.write();
    await t.loop.afterJob();
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_SAVE_MS + 10); // the idle timer still tries again
    expect(t.copies()).toBe(4);
  });

  it("flushInJob, called inside a queue job (a restore holding the queue), makes the copy there and returns only once the store has it", async () => {
    const t = setup();
    await t.loop.afterJob();
    await t.queue.run(async () => {
      t.write(); // the restore's changes
      await t.loop.afterJob();
      expect(t.loop.state().unsaved).toBe(true);
      await t.loop.flushInJob(); // would wait for itself for ever if it went through the queue again
      expect(t.writes).toHaveLength(1);
      expect(t.loop.state()).toMatchObject({ unsaved: false, failed: false });
    });
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_SAVE_MS * 3);
    expect(t.writes).toHaveLength(1); // and nothing is left to save afterwards
  });

  it("flush saves right away (the page is hidden or closing) and does nothing when nothing is unsaved", async () => {
    const t = setup();
    await t.loop.afterJob();
    await t.loop.flush();
    expect(t.writes).toHaveLength(0);
    t.write();
    await t.loop.afterJob();
    await t.loop.flush();
    expect(t.writes).toHaveLength(1);
    expect(t.loop.state().unsaved).toBe(false);
  });

  it("says so when the store refuses, keeps the changes marked unsaved, and recovers on the next try", async () => {
    let fail = true;
    const t = setup({ writeFails: () => fail });
    await t.loop.afterJob();
    t.write();
    await t.loop.afterJob();
    await t.loop.flush();
    expect(t.loop.state()).toMatchObject({ unsaved: true, failed: true });
    fail = false;
    await t.loop.flush();
    expect(t.loop.state()).toMatchObject({ unsaved: false, failed: false });
    expect(t.writes).toHaveLength(1);
  });

  it("is not 'saved' while the copy is still being written, nor for changes made during the write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = setup({ hold: () => gate });
    await t.loop.afterJob();
    t.write();
    await t.loop.afterJob();
    const flushing = t.loop.flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.loop.state().unsaved).toBe(true); // the store has not got it yet
    t.write();
    await t.loop.afterJob(); // an edit while the copy is on its way
    release();
    await flushing;
    expect(t.writes).toHaveLength(1);
    expect(t.loop.state().unsaved).toBe(true); // the copy did not include that edit
    await vi.advanceTimersByTimeAsync(IDLE_BEFORE_SAVE_MS + 10);
    expect(t.writes).toHaveLength(2);
    expect(t.loop.state().unsaved).toBe(false);
  });

  it("with no place to keep a copy it reports that and never claims a save", async () => {
    const t = setup({ kind: "none" });
    await t.loop.afterJob();
    t.write();
    await t.loop.afterJob();
    await t.loop.flush();
    expect(t.writes).toHaveLength(0);
    expect(t.loop.state()).toMatchObject({ store: "none", lastSavedAt: null });
  });
});

// The page's side of a local copy written by a newer build: whichever call the worker refuses with
// local_copy_too_new, the page stops using the copy (server data only) and offers the reload, once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccountStorage } from "../lib/accountStorage";
import { getAppState, resetAppState } from "../lib/appStore";
import { getLocalCopyState, _resetLocalCopyForTests } from "../lib/localCopyState";
import { _resetLocalDbForTests, getPendingWrites, initLocalDb } from "../lib/localDb";

type Msg = { id: number; op: string };
let workers: FakeWorker[];
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror = null; onmessageerror = null; terminated = false;
  constructor() { workers.push(this); }
  postMessage(message: Msg) {
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: false, error: "The local copy was written by a newer version", code: "local_copy_too_new" } }));
  }
  terminate() { this.terminated = true; }
}

beforeEach(() => {
  workers = [];
  vi.stubGlobal("Worker", FakeWorker);
  bindAccountStorage("u", "");
  resetAppState();
  _resetLocalCopyForTests();
  _resetLocalDbForTests();
});
afterEach(() => { _resetLocalDbForTests(); _resetLocalCopyForTests(); vi.unstubAllGlobals(); });

describe("a local copy from a newer build", () => {
  it("refused at open: the page works from server data, offers the reload, and the worker is gone", async () => {
    await expect(initLocalDb()).rejects.toMatchObject({ code: "local_copy_too_new" });
    await vi.waitFor(() => expect(getLocalCopyState()).toBe("none"));
    expect(getAppState().newVersionAvailable).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
    await expect(getPendingWrites()).resolves.toEqual([]); // no queue to be behind: nothing is asked of the copy again
    expect(workers).toHaveLength(1);
  });
});

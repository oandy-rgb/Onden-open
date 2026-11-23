// A stateful stand-in for the local write queue, for tests that mock lib/localDb.
//
// Every save is a queue row from the moment it is made (writeQueue.recordWrite), and the row goes once the server
// has answered. So "was it queued?" is not "was addPendingWrite called?" (it always is) but "is a row left after the
// write settled?": that is what `rows` holds. Rows are found by key, the way the worker finds them.
import { vi } from "vitest";
import type { PendingWrite } from "../../lib/localDb";

type QueueMocks = {
  addPendingWrite: (method: PendingWrite["method"], path: string, body: string | null, idemKey?: string | null) => Promise<void>;
  getPendingWrites: () => Promise<PendingWrite[]>;
  clearPendingWrite: (id: number, idemKey?: string | null) => Promise<void>;
  /** The worker's in-place rewrite of a queued write's request (writeQueue.keepUnsentWrite), when the test wires it. */
  replacePendingWrite?: (method: PendingWrite["method"], path: string, body: string | null, idemKey: string) => Promise<void>;
};

export function memoryQueue(mocks: QueueMocks): { rows: PendingWrite[] } {
  const queue = { rows: [] as PendingWrite[] };
  let next = 1;
  // As the worker: a key names one queued write, so a second record of it changes nothing.
  vi.mocked(mocks.addPendingWrite).mockImplementation(async (method, path, body, idemKey) => {
    if (idemKey && queue.rows.some((row) => row.idem_key === idemKey)) return;
    queue.rows.push({ id: next++, method, path, body, idem_key: idemKey ?? null, attempts: 0 });
  });
  if (mocks.replacePendingWrite) {
    vi.mocked(mocks.replacePendingWrite).mockImplementation(async (method, path, body, idemKey) => {
      const row = queue.rows.find((r) => r.idem_key === idemKey);
      if (row) Object.assign(row, { method, path, body });
      else queue.rows.push({ id: next++, method, path, body, idem_key: idemKey, attempts: 0 });
    });
  }
  vi.mocked(mocks.getPendingWrites).mockImplementation(async () => [...queue.rows]);
  vi.mocked(mocks.clearPendingWrite).mockImplementation(async (id, idemKey) => {
    queue.rows = queue.rows.filter((row) => (idemKey ? row.idem_key !== idemKey : row.id !== id));
  });
  return queue;
}

// The REAL local-copy worker (lib/localDbWorker, a real sql.js database) driven in-process: `rpc` sends one op the way
// lib/localDb does and waits for its reply. The test file mocks `sql.js` (to load the real module) and
// `../lib/indexedDbStorage` (where the copy is saved; a `vi.hoisted` value there survives `reopen`, as a reload keeps
// IndexedDB).

import { vi } from "vitest";

type Reply = { ok: boolean; result?: unknown; error?: string };
let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: Reply) => void>();

export async function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  const id = ++sequence;
  const reply = await new Promise<Reply>((resolve) => { replies.set(id, resolve); receive({ data: { id, op, args, storageScope: null } }); });
  if (!reply.ok) throw new Error(`worker ${op}: ${reply.error}`);
  return reply.result as T;
}

/** A fresh worker module over whatever `disk` holds (a page load). */
export async function openWorker(): Promise<void> {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: Reply & { id: number }) => { replies.get(reply.id)?.(reply); replies.delete(reply.id); } };
  vi.stubGlobal("self", worker);
  await import("../../lib/localDbWorker");
  receive = (worker as unknown as { onmessage: typeof receive }).onmessage;
  await rpc("initLocalDb");
}

/** Save the copy, then load the page again. */
export async function reopen(): Promise<void> {
  await rpc("flushLocalDbSync");
  await openWorker();
}

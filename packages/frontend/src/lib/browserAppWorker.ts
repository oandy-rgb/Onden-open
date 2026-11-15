// The page's end of the worker: send a request, get back a Response whose body streams in.
// Messages: packages/markdown/src/browserBridge.ts. The worker: packages/backend/src/browser/worker.ts.

import type { BootFailureKind, BridgeSaveState, FromWorker, ToWorker } from "@onden/markdown";

export type ReadyInfo = Extract<FromWorker, { t: "ready" }>;

/** The worker could not start; `kind` says which way out to offer (browserApp/BrowserAppShell). */
export class WorkerStartFailure extends Error {
  constructor(readonly kind: BootFailureKind, message: string) {
    super(message);
  }
}

export type WorkerClient = {
  /** Resolves when the database is open and the person is signed in; rejects with a sentence if it could not start. */
  ready: Promise<ReadyInfo>;
  request(request: Request): Promise<Response>;
  /** Write the database to the browser's storage now (the page is going away). */
  flush(): Promise<void>;
  /** Forget the saved copy; the next start begins from the packaged database. */
  reset(): Promise<void>;
  /** The saved copy as stored (a database image, not notes), or null when there is none. Works after a failed start. */
  exportCopy(): Promise<Blob | null>;
  onSaveState(listener: (state: BridgeSaveState) => void): () => void;
  lastSaveState(): BridgeSaveState | null;
};

type Pending = {
  resolve(response: Response): void;
  reject(error: unknown): void;
  body?: ReadableStreamDefaultController<Uint8Array>;
};

const NO_BODY = new Set([101, 204, 205, 304]);

/** `onReplayProgress`: the start is re-running changes a closed page left in the log (`done` of `total`). */
export function startWorkerClient(workerUrl: URL, onReplayProgress?: (done: number, total: number) => void): WorkerClient {
  const worker = new Worker(workerUrl, { type: "module" });
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const done = new Map<number, () => void>();
  const copies = new Map<number, (data: ArrayBuffer | null) => void>();
  const listeners = new Set<(state: BridgeSaveState) => void>();
  let saveState: BridgeSaveState | null = null;
  let resolveReady!: (info: ReadyInfo) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<ReadyInfo>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const send = (message: ToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer);

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    switch (message.t) {
      case "ready": resolveReady(message); return;
      case "replay-progress": onReplayProgress?.(message.done, message.total); return;
      case "boot-failed": rejectReady(new WorkerStartFailure(message.kind, message.message)); return;
      case "copy": copies.get(message.id)?.(message.data); copies.delete(message.id); return;
      case "save-state":
        saveState = message.state;
        for (const listener of listeners) listener(message.state);
        return;
      case "done": done.get(message.id)?.(); done.delete(message.id); return;
      case "head": {
        const entry = pending.get(message.id);
        if (!entry) return;
        const body = NO_BODY.has(message.status) ? null : new ReadableStream<Uint8Array>({ start: (controller) => { entry.body = controller; } });
        entry.resolve(new Response(body, { status: message.status, statusText: message.statusText, headers: message.headers }));
        if (!body) pending.delete(message.id);
        return;
      }
      case "chunk": pending.get(message.id)?.body?.enqueue(new Uint8Array(message.data)); return;
      case "end": pending.get(message.id)?.body?.close(); pending.delete(message.id); return;
      case "failed": {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (entry?.body) entry.body.error(new TypeError(message.message));
        else entry?.reject(new TypeError("Failed to fetch"));
      }
    }
  };
  worker.onerror = () => { rejectReady(new WorkerStartFailure("other", "the worker could not be loaded")); };

  async function request(request: Request): Promise<Response> {
    const id = nextId++;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? null : await request.arrayBuffer();
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      request.signal.addEventListener("abort", () => {
        const entry = pending.get(id);
        pending.delete(id);
        send({ t: "cancel", id });
        const abort = new DOMException("The operation was aborted.", "AbortError");
        if (entry?.body) entry.body.error(abort); else entry?.reject(abort);
      }, { once: true });
      send({ t: "request", id, method, path: url.pathname + url.search, headers: [...request.headers.entries()], body }, body ? [body] : []);
    });
  }

  const roundTrip = (t: "flush" | "reset") => new Promise<void>((resolve) => {
    const id = nextId++;
    done.set(id, resolve);
    send({ t, id });
  });

  return {
    ready,
    request,
    flush: () => roundTrip("flush"),
    reset: () => roundTrip("reset"),
    exportCopy: () => new Promise<Blob | null>((resolve) => {
      const id = nextId++;
      copies.set(id, (data) => resolve(data ? new Blob([data], { type: "application/x-tar" }) : null));
      send({ t: "export-copy", id });
    }),
    onSaveState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    lastSaveState: () => saveState,
  };
}

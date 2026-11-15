// How the browser app's pictures get from the worker to an <img> (lib/browserAppMedia.ts): the page answers the Service
// Worker's questions through the same request path every /api call takes, and a sub-path address becomes the worker's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerMediaRequests, waitForMediaServing, workerPathOf } from "../lib/browserAppMedia";
import type { WorkerClient } from "../lib/browserAppWorker";

describe("workerPathOf", () => {
  it("is the media address the worker knows, from wherever the page is served", () => {
    expect(workerPathOf("https://example.test/api/media/ab12.webp")).toBe("/api/media/ab12.webp");
    expect(workerPathOf("https://example.test/onden-trial/api/media/ab12.webp?v=2")).toBe("/api/media/ab12.webp?v=2");
  });
  it("is nothing for any other address", () => {
    expect(workerPathOf("https://example.test/api/nodes")).toBeNull();
    expect(workerPathOf("https://example.test/api/media/a/b")).toBeNull();
    expect(workerPathOf("https://example.test/favicon.svg")).toBeNull();
  });
});

describe("answerMediaRequests", () => {
  let container: EventTarget;
  // Tests run in a shuffled order: each one sets up its own Service Worker container.
  beforeEach(() => { container = new EventTarget(); Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true }); });
  afterEach(() => vi.restoreAllMocks());

  /** The Service Worker asks `url`; resolves with what the page sent back through the channel. */
  async function ask(client: Pick<WorkerClient, "request">, url: string, method = "GET", headers: Array<[string, string]> = []) {
    const stop = answerMediaRequests(client as WorkerClient);
    const answered = new Promise<{ message: Record<string, unknown>; transfer: unknown[] | undefined }>((resolve) => {
      const port = { postMessage: (message: Record<string, unknown>, transfer?: unknown[]) => resolve({ message, transfer }) };
      container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "onden-media", url, method, headers }, ports: [port] }));
    });
    const result = await answered;
    stop();
    return result;
  }

  it("asks the worker for the file, range included, and hands back its bytes", async () => {
    const request = vi.fn(async (_request: Request) => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-range": "bytes 0-2/9" } }));
    const { message } = await ask({ request }, "https://example.test/onden-trial/api/media/ab12.webp", "GET", [["range", "bytes=0-2"]]);
    const sent = request.mock.calls[0]![0];
    expect(new URL(sent.url).pathname).toBe("/api/media/ab12.webp");
    expect(sent.headers.get("range")).toBe("bytes=0-2");
    expect(message.status).toBe(206);
    expect(new Uint8Array(message.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(Object.fromEntries(message.headers as Array<[string, string]>)["content-range"]).toBe("bytes 0-2/9");
  });

  it("sends no body for a 304 or a HEAD", async () => {
    const notModified = await ask({ request: async () => new Response(null, { status: 304 }) }, "https://example.test/api/media/ab12.webp");
    expect(notModified.message).toMatchObject({ status: 304, body: null });
    const head = await ask({ request: async () => new Response("x", { status: 200 }) }, "https://example.test/api/media/ab12.webp", "HEAD");
    expect(head.message).toMatchObject({ status: 200, body: null });
  });

  it("answers 502 when the worker cannot, and ignores messages that are not its own", async () => {
    const { message } = await ask({ request: async () => { throw new TypeError("Failed to fetch"); } }, "https://example.test/api/media/ab12.webp");
    expect(message.status).toBe(502);
    const stop = answerMediaRequests({ request: vi.fn() } as unknown as WorkerClient);
    const port = { postMessage: vi.fn() };
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "remember" }, ports: [port] }));
    expect(port.postMessage).not.toHaveBeenCalled();
    stop();
  });
});

describe("waitForMediaServing", () => {
  it("says so when the browser has no Service Worker, or the registration failed", async () => {
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
    expect(await waitForMediaServing(Promise.resolve(undefined))).toBe("unsupported");
    Object.defineProperty(navigator, "serviceWorker", { value: Object.assign(new EventTarget(), { controller: null }), configurable: true });
    expect(await waitForMediaServing(Promise.resolve(undefined))).toBe("failed");
  });
  it("is serving once the page is controlled", async () => {
    const container = Object.assign(new EventTarget(), { controller: {}, ready: Promise.resolve({}) });
    Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
    expect(await waitForMediaServing(Promise.resolve({} as ServiceWorkerRegistration))).toBe("serving");
  });
});

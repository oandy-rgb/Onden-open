import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";

/** A server-sent-events response held open until `close()` or the client leaves:
 *  no proxy buffering, and the stream's own `onAbort` closes it. `setup` registers
 *  its writers and, via `onClose`, its cleanup; it may await before the stream is held. */
export function holdOpenStream(
  c: Context,
  setup: (handle: { stream: SSEStreamingApi; close: () => void; isClosed: () => boolean; onClose: (cleanup: () => void) => void }) => void | Promise<void>,
) {
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache");
  return streamSSE(c, async (stream) => {
    let closed = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cleanups: Array<() => void> = [];
    const close = () => {
      if (closed) return;
      closed = true;
      for (const cleanup of cleanups) cleanup();
      release();
    };
    stream.onAbort(close);
    await setup({ stream, close, isClosed: () => closed, onClose: (cleanup) => { cleanups.push(cleanup); } });
    await held;
  });
}

// Work that only needs to be right once typing or caret movement pauses (what the phone bar offers at the caret):
// every call restarts the wait, so a burst of keystrokes costs one run instead of one per key.

type AfterPause = { schedule(): void; cancel(): void };

/** Runs `run` once, `ms` after the last `schedule()`; `cancel()` drops a pending run. */
export function afterPause(run: () => void, ms: number): AfterPause {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  return {
    schedule() { cancel(); timer = setTimeout(() => { timer = null; run(); }, ms); },
    cancel,
  };
}

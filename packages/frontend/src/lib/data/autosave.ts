import type { WriteResult } from "./writeQueue";

export type AutosaveStatus = "idle" | "unsaved" | "saving" | "synced" | "queued" | "error";
type Save = (options: { keepalive: boolean }) => Promise<{ status: WriteResult<unknown>["status"] }>;
type Entry = { save: Save; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; failed?: boolean };

/** Per-document debounce, flush and explicit retry. Domain writers report
 * failures; this controller retains the latest failed draft until accepted.
 * A newer draft replaces a waiting draft, never an in-flight request. */
export function createAutosave(notify: (status: AutosaveStatus) => void) {
  const entries = new Map<string, Entry>();
  const running = new Set<Promise<void>>();
  let last: AutosaveStatus = "idle";
  const emit = () => notify([...entries.values()].some((entry) => entry.failed) ? "error"
    : running.size ? "saving" : entries.size ? "unsaved" : last);

  function start(key: string, entry: Entry, keepalive: boolean): Promise<void> {
    if (entry.running) return entry.running;
    clearTimeout(entry.timer); entry.timer = undefined; entry.failed = false;
    // Invoke synchronously: keepalive writers must record recovery before the
    // first await, while pagehide still has a live document.
    const operation = entry.save({ keepalive });
    const task = operation.then((result) => {
      last = result.status;
      if (entries.get(key) === entry) entries.delete(key);
    }, () => { entry.failed = true; }).finally(() => {
      running.delete(task); entry.running = undefined; emit();
    });
    entry.running = task; running.add(task); emit();
    return task;
  }

  function schedule(key: string, save: Save, delay = 800) {
    clearTimeout(entries.get(key)?.timer);
    const entry: Entry = { save };
    entries.set(key, entry);
    entry.timer = setTimeout(() => { void start(key, entry, false); }, delay);
    emit();
  }

  async function flush(keepalive = false): Promise<boolean> {
    const tasks = [...entries].map(([key, entry]) => start(key, entry, keepalive));
    await Promise.all([...running, ...tasks]);
    return entries.size === 0;
  }

  /** Drop the draft waiting under `key` (failed or not yet sent) — after the
   *  server refused it as stale and the editor reloaded the current copy, so
   *  neither a retry nor a flush sends it again. One already in flight is
   *  left to finish. */
  function discard(key: string) {
    const entry = entries.get(key);
    if (!entry || entry.running) return;
    clearTimeout(entry.timer);
    entries.delete(key);
    emit();
  }

  return { schedule, flush, discard };
}

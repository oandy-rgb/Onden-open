// One queue for everything the worker runs: HTTP requests, periodic jobs, saving a copy.
// The backend's request context is a stack (requestContext.ts createSerialContextProvider), which is only
// correct when two flows never overlap — so nothing runs outside this queue.

export type SerialQueue = {
  /** Run `job` after everything queued before it; its result or error is the returned promise's. */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** Run `job` before the jobs still waiting (a save when the page is closing). */
  runNext<T>(job: () => Promise<T>): Promise<T>;
};

export function createSerialQueue(): SerialQueue {
  const waiting: Array<() => Promise<void>> = [];
  let running = false;

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let next = waiting.shift(); next; next = waiting.shift()) await next();
    } finally {
      running = false;
    }
  }

  const enqueue = <T>(job: () => Promise<T>, front: boolean): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const task = async (): Promise<void> => {
        try { resolve(await job()); } catch (error) { reject(error); }
      };
      if (front) waiting.unshift(task); else waiting.push(task);
      void drain();
    });

  return { run: (job) => enqueue(job, false), runNext: (job) => enqueue(job, true) };
}

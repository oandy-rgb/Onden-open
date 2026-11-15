/** RPCs can arrive before the boot hook (or concurrently with it). They all
 * await one initialization, including lazily imported callers. A failed open
 * is observable and a later explicit operation may retry; there is no loop. */
export function createInitializationGate(initialize: () => Promise<void>) {
  let ready: Promise<void> | undefined;
  return () => {
    if (!ready) {
      ready = initialize().catch((error) => { ready = undefined; throw error; });
    }
    return ready;
  };
}

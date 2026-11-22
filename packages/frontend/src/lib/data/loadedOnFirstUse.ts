// A writer made of async methods whose code is fetched the first time one of them is called, not at boot.
// For writes that need a connection anyway (a version restore, a module switch, a part moved into a child note):
// the first call waits for one small file, which lib/offlineWarmup keeps for the service worker.
// A failed fetch is not remembered, so the next call tries again.

type AsyncApi<W> = { [K in keyof W]: (...args: never[]) => Promise<unknown> };

export function loadedOnFirstUse<W extends AsyncApi<W>>(load: () => Promise<W>, methods: readonly (keyof W & string)[]): W {
  let loaded: Promise<W> | null = null;
  const writer = (): Promise<W> => {
    const pending = (loaded ??= load());
    pending.catch(() => { if (loaded === pending) loaded = null; });
    return pending;
  };
  const api: Partial<Record<keyof W & string, unknown>> = {};
  for (const method of methods) {
    api[method] = (...args: unknown[]) => writer().then((w) => (w[method] as unknown as (...a: unknown[]) => Promise<unknown>)(...args));
  }
  return api as W;
}

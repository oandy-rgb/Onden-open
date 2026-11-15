// Fuse.js (typo-tolerant matching) is ~6 KiB gzip that no first screen needs: it is
// fetched the first time a search or the command palette wants it, and kept warm for
// offline by lib/offlineWarmup.ts (same module, so the warmed file is the one used).
import type FuseClass from "fuse.js";

type FuseConstructor = typeof FuseClass;

let loaded: FuseConstructor | null = null;
let loading: Promise<FuseConstructor> | null = null;

/** Fuse once it has loaded, else null (callers then use a plain match). */
export function loadedFuse(): FuseConstructor | null {
  return loaded;
}

/** Fetch Fuse (once); a failed fetch is retried by the next call. */
export function loadFuse(): Promise<FuseConstructor> {
  return loading ??= import("fuse.js").then(
    (mod) => (loaded = mod.default),
    (error: unknown) => { loading = null; throw error; },
  );
}

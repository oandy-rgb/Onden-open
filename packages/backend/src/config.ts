// ── Environment configuration ────────────────────────────────────────────
// The one place that reads `process.env` (ESLint no-restricted-properties; the
// only other reader is logger.ts, which must see per-call changes). Callers ask
// for a typed value with a default instead of casting a string themselves.
//
// Bad values: an unset or empty variable is "not configured" and yields the
// default. A set-but-unusable integer (`PG_POOL_MAX=abc`, below `min`) also
// yields the default, with a `log.warn` naming the variable — a typo in a tuning
// knob must not boot the server with NaN, nor refuse to boot. Settings whose
// wrong value is unsafe to guess (ONDEN_SIGNUP, ONDEN_TIMEZONE) validate
// themselves and throw at startup; they read the raw string through `str`.
//
// Reads are lazy (per call), not frozen at import: dotenv/test setup can run
// after import, and tests flip NODE_ENV and friends mid-process.
//
//   const max = config.int("PG_POOL_MAX", 20, { min: 1 });
//   if (config.is("RATE_LIMIT_BACKEND", "pg")) …
//   if (isTest()) …

/** Where config's own warnings go. logger.ts registers itself here: config cannot import the
 *  logger, because the logger reads LOG_LEVEL / LOG_FORMAT from config (no import cycle). A warning
 *  raised before the logger has loaded waits and is passed on when it registers. */
let warnSink: ((msg: string) => void) | null = null;
const pendingWarnings: string[] = [];
export function onConfigWarning(sink: (msg: string) => void): void {
  warnSink = sink;
  for (const msg of pendingWarnings.splice(0)) sink(msg);
}
function warn(msg: string): void {
  if (warnSink) warnSink(msg);
  else pendingWarnings.push(msg);
}

/** A host that is not started from a shell (the browser worker, the snapshot build) sets its environment here,
 *  before the first import of db.ts and auth.ts, which read some of it when they load (src/browser/env.ts). */
export function setEnvironment(values: Record<string, string>): void {
  Object.assign(process.env, values);
}

/** The raw environment, for the few APIs that take an injectable env object. */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export const config = {
  /** The variable as set (empty string included), or undefined. */
  str(key: string): string | undefined {
    return process.env[key];
  },

  /** An integer ≥ `min` (default 0). Unset/empty → fallback; unusable → fallback + warning. */
  int(key: string, fallback: number, opts: { min?: number } = {}): number {
    const raw = process.env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= (opts.min ?? 0)) return n;
    warn(`${key}="${raw}" is not an integer ≥ ${opts.min ?? 0}; using ${fallback}`);
    return fallback;
  },

  /** True when the variable is exactly `value` (flags are "1", modes are words). */
  is(key: string, value: string): boolean {
    return process.env[key] === value;
  },

  /** Address the HTTP server binds to. Unset/empty → undefined, which Node reads as "all interfaces":
   *  the server and Docker deployments need that (nginx reaches the backend over the container network).
   *  The desktop app sets ONDEN_LISTEN_HOST=127.0.0.1 so other devices on the LAN cannot reach it. */
  listenHost(): string | undefined {
    return process.env.ONDEN_LISTEN_HOST?.trim() || undefined;
  },
};

export function isTest(): boolean {
  return process.env.NODE_ENV === "test";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

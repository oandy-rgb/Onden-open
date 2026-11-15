import { getApiBase } from "./api";

// The live stream — subscribe to the backend's blind-tick SSE stream
// (GET /api/events/stream) through ONE shared EventSource for the whole tab.
//
// A tick is a delivery HINT, never a fact: the channel carries only
//   { kind: "changed", latest: <event id> }   a domain event committed
//   { kind: "effects" }                       an outbox row changed status
//   { kind: "membership_changed", epoch }     a permission change
// — no ids, no titles, no event types. Consumers react by refetching the
// existing read-policy-filtered endpoints, so nothing new can leak here and
// reconnect recovery is a plain refetch (nothing is lost with the socket).
//
// Ticks: "changed" (a domain event committed, with its id), "effects" (an
// outbox row changed status), "membership_changed" (a permission change, with
// the new epoch). WHO refreshes WHAT on each — and the stream reopening, the
// tab becoming visible, the echo of this tab's own writes — is decided in
// lib/liveInvalidation.ts, the only subscriber of this stream.
//
// DEGRADATION: when the EventSource is down (SSE unsupported, proxy buffering,
// server restart) registrations keep a slow fallback poll (~60s,
// liveInvalidation `pollMs`); reconnects use exponential backoff (1s → 30s
// cap) and reset on success.

export type LiveTick =
  | { kind: "changed"; latest: number }
  | { kind: "effects" }
  | { kind: "membership_changed"; epoch: number };

type TickListener = (tick: LiveTick) => void;
type ConnListener = (connected: boolean) => void;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// The server sends a `data:` heartbeat every 25 s (EventSource can't see `:`
// comments). No frame at all for this long ⇒ the connection is half-open (a
// phone that changed network): drop it and reconnect.
const SILENCE_LIMIT_MS = 60_000;
const WATCHDOG_MS = 15_000;

const tickListeners = new Set<TickListener>();
const connListeners = new Set<ConnListener>();
let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = RECONNECT_BASE_MS;
let connected = false;
let lastFrameAt = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

function stopWatchdog(): void {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
}

function dropSilentStream(es: EventSource): void {
  es.close();
  if (source === es) source = null;
  stopWatchdog();
  setConnected(false);
  scheduleReconnect();
}

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const l of [...connListeners]) {
    try { l(next); } catch { /* listener error — isolate */ }
  }
}

/** Is the shared stream currently open? (Consumers use this to choose the
 *  slow-fallback poll cadence vs their original one.) */
export function isLiveConnected(): boolean {
  return connected;
}

function parseTick(raw: string): LiveTick | null {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; latest?: unknown; epoch?: unknown };
    if (parsed?.kind === "changed" && typeof parsed.latest === "number") {
      return { kind: "changed", latest: parsed.latest };
    }
    if (parsed?.kind === "effects") return { kind: "effects" };
    if (parsed?.kind === "membership_changed" && typeof parsed.epoch === "number") {
      return { kind: "membership_changed", epoch: parsed.epoch };
    }
  } catch { /* not a tick — ignore */ }
  return null;
}

function connect(): void {
  if (source || typeof EventSource === "undefined") return;
  let es: EventSource;
  try {
    // withCredentials: the stream is auth-gated by the same session cookie as
    // every other /api route.
    es = new EventSource(`${getApiBase()}/api/events/stream`, { withCredentials: true });
  } catch {
    scheduleReconnect();
    return;
  }
  source = es;
  lastFrameAt = Date.now();
  stopWatchdog();
  watchdog = setInterval(() => {
    if (source === es && Date.now() - lastFrameAt > SILENCE_LIMIT_MS) dropSilentStream(es);
  }, WATCHDOG_MS);
  es.onopen = () => {
    lastFrameAt = Date.now();
    backoffMs = RECONNECT_BASE_MS; // healthy again — reset the backoff ladder
    setConnected(true);
  };
  es.onmessage = (ev: MessageEvent<string>) => {
    lastFrameAt = Date.now(); // heartbeats count: they parse to no tick
    const tick = parseTick(ev.data);
    if (!tick) return;
    for (const l of [...tickListeners]) {
      try { l(tick); } catch { /* listener error — isolate */ }
    }
  };
  es.onerror = () => {
    // EventSource has its own retry, but it gives no backoff control and goes
    // permanently dead on some failures (e.g. 401 during a re-auth window) —
    // own the reconnect loop instead.
    dropSilentStream(es);
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer || tickListeners.size === 0) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (tickListeners.size > 0) connect();
  }, delay);
}

function teardown(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopWatchdog();
  source?.close();
  source = null;
  backoffMs = RECONNECT_BASE_MS;
  setConnected(false);
}

/** Subscribe to ticks on the shared stream (opens it on first subscriber,
 *  closes it when the last one leaves). Returns the unsubscribe function. */
export function subscribeLiveTicks(onTick: TickListener, onConnection?: ConnListener): () => void {
  tickListeners.add(onTick);
  if (onConnection) {
    connListeners.add(onConnection);
    onConnection(connected);
  }
  connect();
  return () => {
    tickListeners.delete(onTick);
    if (onConnection) connListeners.delete(onConnection);
    if (tickListeners.size === 0) teardown();
  };
}

/** Tests only: drop all listeners and close the shared stream. */
export function _resetLiveEventsForTests(): void {
  tickListeners.clear();
  connListeners.clear();
  teardown();
}

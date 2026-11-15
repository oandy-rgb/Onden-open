// Realtime hub — blind-tick fan-out for the SSE stream (/api/events/stream).
//
// SECURITY MODEL (pinned, see the SSE route): the channel is a read-side
// DELIVERY HINT, never a third rail. No message here may be the only place a
// fact exists, and no message carries content: a tick is exactly
//
//   { kind: "changed", latest: <highest committed domain_event id> }
//   { kind: "effects" }                       (an outbox row changed status)
//
// — no target ids, no titles, no event types. Leak surface is zero BY
// CONSTRUCTION: clients react to a tick by refetching the existing
// read-policy-filtered endpoints (/api/sync?since, /api/events, /api/inbox…),
// so the read policy stays implemented in exactly one place. `latest` is safe
// to share: domain_events.id is a workspace-global bigserial whose high-water
// mark is already returned by /api/sync to every authenticated caller.
//
// SCOPE: single-process backend → a process-local emitter is the correct
// mechanism. The multi-process upgrade path is Postgres LISTEN/NOTIFY
// (NOTIFY onden_changed / onden_effects after commit; each process LISTENs and
// feeds its local hub) — the hub's API would not change.
//
// Producers must notify AFTER commit (spine/txHooks.afterCommit), never
// inside the transaction. Bursts coalesce: at most one flush per ~250ms,
// carrying the highest event id seen in the window.
import { log } from "../logger.js";
import { startTicker } from "../ticker.js";

export type RealtimeTick =
  | { kind: "changed"; latest: number }
  | { kind: "effects" }
  // A permission change bumped the workspace membership epoch. Blind like the
  // others: the epoch is safe to share (it carries no content — just "the read
  // set may have moved"); the client reacts by reconciling membership against the
  // read-policy-filtered endpoints. Lets the client RAISE its fail-closed gate at
  // commit time instead of waiting for the next poll to notice the epoch.
  | { kind: "membership_changed"; epoch: number };

type Listener = (tick: RealtimeTick) => void;

const COALESCE_MS = 250;

const listeners = new Set<Listener>();
let pendingLatest: number | null = null;
let pendingEffects = false;
let pendingMembershipEpoch: number | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function flush(): void {
  flushTimer = null;
  const ticks: RealtimeTick[] = [];
  if (pendingLatest !== null) {
    ticks.push({ kind: "changed", latest: pendingLatest });
    pendingLatest = null;
  }
  if (pendingEffects) {
    ticks.push({ kind: "effects" });
    pendingEffects = false;
  }
  if (pendingMembershipEpoch !== null) {
    ticks.push({ kind: "membership_changed", epoch: pendingMembershipEpoch });
    pendingMembershipEpoch = null;
  }
  for (const tick of ticks) {
    for (const listener of [...listeners]) {
      try { listener(tick); } catch (e) { log.error("realtime", "listener failed", { err: e }); }
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return; // a flush is already pending — the burst coalesces into it
  flushTimer = setTimeout(flush, COALESCE_MS);
  // Never hold the process open for a pending tick (tests, graceful shutdown).
  flushTimer.unref?.();
}

/** A domain event committed. Coalesces; the flushed tick carries the highest id. */
export function notifyChanged(latestEventId: string | number): void {
  const id = Number(latestEventId);
  if (!Number.isFinite(id) || id <= 0) return;
  pendingLatest = Math.max(pendingLatest ?? 0, id);
  scheduleFlush();
}

/** An outbox row changed status (enqueued / approved / done / dead / retry). */
export function notifyEffects(): void {
  pendingEffects = true;
  scheduleFlush();
}

/** A permission change bumped the membership epoch. Coalesces to the highest. */
export function notifyMembershipChanged(epoch: number): void {
  const e = Number(epoch);
  if (!Number.isFinite(e)) return;
  pendingMembershipEpoch = Math.max(pendingMembershipEpoch ?? 0, e);
  scheduleFlush();
}

/** Subscribe to flushed ticks. Returns the unsubscribe function. */
export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * `subscribeRealtime` plus a heartbeat every `heartbeatMs`, for a held-open stream: the client tells a half-open
 * connection from a quiet one by the heartbeat. Returns one stop function for both.
 */
export function subscribeRealtimeWithHeartbeat(
  listener: Listener, onHeartbeat: () => void, heartbeatMs: number,
): () => void {
  const unsubscribe = subscribeRealtime(listener);
  const stopHeartbeat = startTicker(heartbeatMs, onHeartbeat);
  return () => { unsubscribe(); stopHeartbeat(); };
}

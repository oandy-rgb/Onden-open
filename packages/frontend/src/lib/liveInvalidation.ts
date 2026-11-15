// When to refetch, decided in one place. Every surface that shows server state
// registers what it refetches and on which signal; this module owns the
// signals: the blind-tick SSE stream (the only subscribeLiveTicks caller),
// the stream reopening, the tab becoming visible, the browser coming back
// online, and a slow poll while the stream is down.
//
// TOPICS (a tick carries nothing — refetch through the read-filtered endpoints):
//   "changed"    a domain event committed (ticks carry its id as `latest`):
//                  BuilderApp — sync() deltas + the inbox; the event log;
//                  review stats / decks / queue
//   "effects"    an outbox row changed status: BuilderApp — held approvals
//   "membership" a permission change (membership_changed, with its epoch):
//                  BuilderApp — gate + reconcile; the review queue
//   "reconnect"  the stream reopened: ticks sent while it was down are lost,
//                  so a handshake (BuilderApp: sync with the epoch check)
//   "visible"    the tab became visible again (due-soon reminders, the
//                  membership gate's retry) — no tick involved
//
// Each registration runs single-flight: a signal while its refetch is running
// queues ONE more run after it, so nothing is lost and a burst is one fetch.
//
// ECHO: this tab's own writes come back as "changed" ticks for a change it
// already shows. A registration with `collapseEcho` (BuilderApp's sync) folds
// the "changed" ticks of the ECHO_MS after a write (noteLocalWrite) into one
// trailing refetch — a save is one sync, not one per event it committed.
// Other people's changes still arrive, at most ECHO_MS later. Surfaces that
// must re-read at once (the review queue after a grade) don't opt in.

import { useEffect, useRef } from "react";
import { onAppResume } from "./appResume";
import { isLiveConnected, subscribeLiveTicks, type LiveTick } from "./liveEvents";

export type LiveTopic = "changed" | "effects" | "membership" | "reconnect" | "visible";

export type RefetchOptions = {
  /** Also refetch when the stream reopens (default: true for "changed"). */
  onReconnect?: boolean;
  /** Also refetch when the tab becomes visible again (default false). */
  onVisible?: boolean;
  /** Also refetch when the browser comes back online (default false). */
  onOnline?: boolean;
  /** While the stream is down, refetch this often (ms; default none). */
  pollMs?: number;
  /** Fold the "changed" echoes of this tab's own writes into one trailing
   *  refetch (default false). */
  collapseEcho?: boolean;
};

type Refetch = (tick?: LiveTick) => unknown;
type Entry = { topic: LiveTopic; refetch: Refetch; opts: RefetchOptions; running: boolean; again: boolean; poll: ReturnType<typeof setInterval> | null };

export const ECHO_MS = 1_500;

const entries = new Set<Entry>();
let unsubscribe: (() => void) | null = null;
let stopResume: Array<() => void> = [];
let connected = false;
let echoUntil = 0;
let echoTimer: ReturnType<typeof setTimeout> | null = null;

function run(entry: Entry, tick?: LiveTick): void {
  if (!entries.has(entry)) return;
  if (entry.running) { entry.again = true; return; }
  entry.running = true;
  let result: unknown;
  try { result = entry.refetch(tick); } catch { result = undefined; } // the surface keeps what it had
  void Promise.resolve(result).catch(() => {}).finally(() => {
    entry.running = false;
    if (entry.again) { entry.again = false; run(entry, tick); }
  });
}

function runTopic(topic: LiveTopic, tick?: LiveTick): void {
  for (const entry of [...entries]) if (entry.topic === topic) run(entry, tick);
}

function changed(tick: LiveTick): void {
  const wait = echoUntil - Date.now();
  const all = [...entries].filter((entry) => entry.topic === "changed");
  for (const entry of all) if (wait <= 0 || !entry.opts.collapseEcho) run(entry, tick);
  if (wait <= 0 || echoTimer || !all.some((entry) => entry.opts.collapseEcho)) return;
  // Inside the echo window: one trailing refetch when it closes.
  echoTimer = setTimeout(() => {
    echoTimer = null;
    for (const entry of [...entries]) if (entry.topic === "changed" && entry.opts.collapseEcho) run(entry, tick);
  }, wait);
}

function onTick(tick: LiveTick): void {
  if (tick.kind === "changed") changed(tick);
  else if (tick.kind === "effects") runTopic("effects", tick);
  else runTopic("membership", tick);
}

function onConnection(next: boolean): void {
  const reopened = next && !connected;
  connected = next;
  for (const entry of entries) syncPoll(entry);
  if (!reopened) return;
  for (const entry of [...entries]) {
    if (entry.topic === "reconnect" || (entry.opts.onReconnect ?? entry.topic === "changed")) run(entry);
  }
}

function syncPoll(entry: Entry): void {
  const want = !connected && !!entry.opts.pollMs;
  if (want && !entry.poll) entry.poll = setInterval(() => run(entry), entry.opts.pollMs);
  if (!want && entry.poll) { clearInterval(entry.poll); entry.poll = null; }
}

function onVisibility(): void {
  if (document.visibilityState !== "visible") return;
  for (const entry of [...entries]) if (entry.topic === "visible" || entry.opts.onVisible) run(entry);
}

function onOnline(): void {
  for (const entry of [...entries]) if (entry.opts.onOnline) run(entry);
}

function start(): void {
  if (unsubscribe) return;
  connected = isLiveConnected();
  unsubscribe = subscribeLiveTicks(onTick, onConnection);
  stopResume = [onAppResume(onVisibility, ["visible"]), onAppResume(onOnline, ["online"])];
}

function stop(): void {
  unsubscribe?.();
  unsubscribe = null;
  for (const f of stopResume) f();
  stopResume = [];
  if (echoTimer) { clearTimeout(echoTimer); echoTimer = null; }
}

/** Refetch on `topic` (and the options' extra signals). Returns the unregister. */
export function register(topic: LiveTopic, refetch: Refetch, opts: RefetchOptions = {}): () => void {
  const entry: Entry = { topic, refetch, opts, running: false, again: false, poll: null };
  entries.add(entry);
  start();
  syncPoll(entry);
  return () => {
    entries.delete(entry);
    if (entry.poll) clearInterval(entry.poll);
    if (entries.size === 0) stop();
  };
}

/** This tab just wrote: its "changed" echoes collapse for ECHO_MS. */
export function noteLocalWrite(): void {
  echoUntil = Date.now() + ECHO_MS;
}

/** React binding; the refetch rides in a ref so re-renders keep one registration. */
export function useLiveRefetch(topic: LiveTopic, refetch: Refetch, opts: RefetchOptions = {}): void {
  const ref = useRef(refetch);
  ref.current = refetch;
  const { onReconnect, onVisible, onOnline: online, pollMs, collapseEcho } = opts;
  useEffect(
    () => register(topic, (tick) => ref.current(tick), { onReconnect, onVisible, onOnline: online, pollMs, collapseEcho }),
    [topic, onReconnect, onVisible, online, pollMs, collapseEcho],
  );
}

/** Tests only. */
export function _resetLiveInvalidationForTests(): void {
  for (const entry of entries) if (entry.poll) clearInterval(entry.poll);
  entries.clear();
  stop();
  connected = false;
  echoUntil = 0;
}

// The focus running now, for every screen that shows it (the bar on a phone, the
// full screen on a desktop, the little mark when it is tucked away) and the
// steps that begin and end it.
//
// The server's running record is the truth (GET /api/tasks/focus): a reload or
// another device reads it back. This file only holds the copy the screens draw
// from, the request to begin one (so the palette, a task and the day page ask
// the same way) and the 「做了什麼？」 step. The length is the account's last
// choice (focusMinutes): the record has no length of its own, so the device that
// did not start it counts down by the same pref.

import { useSyncExternalStore } from "react";
import { createAccountPref } from "../accountPrefStore";
import { PREFS, getPrefJson, removePref, setPrefJson } from "../prefs";
import { focusWriter, reads, type EndFocusInput, type FocusWritten } from "../data";
import { randomUUID } from "../uuid";
import { DEFAULT_FOCUS_MINUTES, parseFocusMinutes } from "./focusClock";
import type { FocusCycleSetting, FocusRun } from "./focusCycle";
import type { FocusSession } from "@onden/contract";

export const focusMinutesPref = createAccountPref<number>({
  serverKey: "focusMinutes",
  follows: "account", // length of a focus session: a habit, same on every screen
  copy: PREFS.focusMinutesCopy,
  parse: parseFocusMinutes,
});

/** The length in minutes the next focus starts with, and the one a running focus counts by (0: no timer). */
export function useFocusMinutes(): number {
  return focusMinutesPref.useValue().value ?? DEFAULT_FOCUS_MINUTES;
}

/** The running record; `synced` false while only this device has it (begun offline). */
export type RunningFocus = FocusSession & { synced: boolean };

export type FocusState = {
  running: RunningFocus | null;
  /** The person asked to begin one (a task, or null: nothing in particular). */
  request: { taskId: string | null } | null;
  /** The 「做了什麼？」 step is open; `endedAt` is when 結束 was pressed. */
  ending: { endedAt: string } | null;
  /** Desktop: the full screen is up (false: tucked into the little mark). */
  expanded: boolean;
  /** The cycle run this device is in (null: one focus, or this device does not know of a cycle). */
  run: FocusRun | null;
};

const EMPTY: FocusState = { running: null, request: null, ending: null, expanded: false, run: null };
let state: FocusState = EMPTY;
const listeners = new Set<() => void>();
const set = (next: Partial<FocusState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()); };

export const focusStore = {
  get: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export const useFocusState = (): FocusState => useSyncExternalStore(focusStore.subscribe, focusStore.get, focusStore.get);

/** Records this device ended whose end the server may not have heard yet (queued
 *  offline): a read in between must not bring their bar back. */
const endedHere = new Set<string>();
/** This device ended the record `id` (the server may not have heard yet). */
export const noteEndedHere = (id: string): void => { endedHere.add(id); };

/** Change the run and keep this device's copy of it in step (a reload during a break comes back to it). */
export function setRun(run: FocusRun | null, more: Partial<FocusState> = {}): void {
  if (run) setPrefJson(PREFS.focusRun, run); else removePref(PREFS.focusRun);
  set({ ...more, run });
}
/** The run this device saved for `recordId` (the parser loads only when something was saved). */
async function persistedRun(recordId: string): Promise<FocusRun | null> {
  const raw = getPrefJson(PREFS.focusRun);
  if (raw === null) return null;
  const run = (await import("./focusRunSteps")).parseFocusRun(raw);
  return run && run.recordId === recordId ? run : null;
}

/** Read the running record from the server. An unreachable server leaves what is shown as it is. */
export async function refreshFocus(): Promise<void> {
  try {
    const { running } = await reads.workspace.focusOfDay();
    if (running && endedHere.has(running.id)) return;
    // A record this device began offline is not on the server yet: keep it until the queue delivers it.
    if (!running && state.running && !state.running.synced) return;
    // Between ending a round's record and beginning the next one the run waits at the question with no open record.
    if (!running && state.run?.recordEnded) return;
    // The run belongs to the record it waits on; none for this record (or no record): a saved run is stale and goes.
    const run = running && (state.run?.recordId === running.id ? state.run : await persistedRun(running.id));
    setRun(run || null, { running: running ? { ...running, synced: true } : null, ...(running ? {} : { ending: null, expanded: false }) });
  } catch { /* offline: the copy stands */ }
}

/** Ask to begin a focus on `taskId` (null: nothing in particular). The screen
 *  that answers (modules/tasks/focus) asks the length, or whether to end the one running. */
export function requestFocus(taskId: string | null = null): void {
  set({ request: { taskId } });
}
export function dismissFocusRequest(): void { set({ request: null }); }
export function setFocusExpanded(expanded: boolean): void { set({ expanded }); }
/** Open 「做了什麼？」. The record ends at `at` (default: now, the moment 結束 was pressed). */
export function openFocusEnding(at: string = new Date().toISOString()): void { if (state.running) set({ ending: { endedAt: at } }); }
export function closeFocusEnding(): void { set({ ending: null }); }

/** Begin a focus of `minutes` on `taskId`. Throws what the write throws (a
 *  refusal, no connection); the request stays open so the person can retry. */
export async function beginFocus(taskId: string | null, minutes: number, expand: boolean, cycle: FocusCycleSetting | null = null): Promise<void> {
  focusMinutesPref.store.save(minutes);
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  // Loaded before anything is written: a failure to load fails the start, never a record the server already has.
  const run = cycle && minutes > 0 ? (await import("./focusRunSteps")).startRun(id, minutes, cycle) : null;
  try {
    const result = await focusWriter.start({ id, taskId, startedAt });
    const record = result.status === "synced" ? result.value : { id, task_id: taskId, started_at: startedAt, ended_at: null, note: "" };
    setRun(run, { running: { ...record, synced: result.status === "synced" }, request: null, expanded: expand });
  } catch (error) {
    // Another device may have begun one meanwhile: show it, so the person is asked about it.
    await refreshFocus();
    throw error;
  }
}

/** End the running record with what was done. `queued` when only this device
 *  has it (offline); otherwise `written` says where the sentence landed. */
export async function endFocusWith(input: Omit<EndFocusInput, "endedAt">): Promise<{ status: "queued" } | { status: "synced"; written: FocusWritten }> {
  const { running, ending } = state;
  if (!running || !ending) throw new Error("no focus to end");
  // A run's pending record ends at the instant its time was up, so that instant goes to the server (a plain end lets it stamp "now").
  const result = await focusWriter.end(running.id, { ...input, endedAt: ending.endedAt, ...(state.run && state.run.phase !== "focus" ? { fixedEnd: true } : {}) });
  endedHere.add(running.id);
  setRun(null, { running: null, ending: null, expanded: false });
  return result.status === "synced" ? { status: "synced", written: result.value.written } : { status: "queued" };
}

/** Sessions whose time-is-up prompt came up in this page's life: it comes once. True the first time asked. */
const promptedTimeUp = new Set<string>();
export function claimTimeUpPrompt(sessionId: string): boolean {
  if (promptedTimeUp.has(sessionId)) return false;
  promptedTimeUp.add(sessionId);
  return true;
}

/** Tests only. */
export function resetFocusStore(): void { state = EMPTY; endedHere.clear(); promptedTimeUp.clear(); listeners.clear(); focusMinutesPref.store.forget(); }

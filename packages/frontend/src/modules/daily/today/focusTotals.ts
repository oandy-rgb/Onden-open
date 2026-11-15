// How long a day was really spent in focus, from the day's focus records (reads.workspace.focusOfDay):
// per task, and in all. The running record counts up to now. Pure.

import type { FocusSession } from "@onden/contract";
import { dateIdAt } from "../../../lib/localDate";

export type FocusTotals = {
  /** Whole minutes per task (a record on no task counts only toward `total`). */
  byTask: ReadonlyMap<string, number>;
  total: number;
};

const minutesBetween = (fromIso: string, toMs: number) => Math.max(0, toMs - Date.parse(fromIso)) / 60_000;

export function focusTotals(date: string, sessions: readonly FocusSession[], running: FocusSession | null, nowMs: number): FocusTotals {
  // The running record belongs to the day it began on, once (as focusDayItems lists it).
  const all = running && !sessions.some((s) => s.id === running.id) && dateIdAt(new Date(running.started_at)) === date ? [...sessions, running] : sessions;
  const exact = new Map<string, number>();
  let totalExact = 0;
  for (const session of all) {
    const minutes = minutesBetween(session.started_at, session.ended_at === null ? nowMs : Date.parse(session.ended_at));
    totalExact += minutes;
    if (session.task_id) exact.set(session.task_id, (exact.get(session.task_id) ?? 0) + minutes);
  }
  return { byTask: new Map([...exact].map(([id, minutes]) => [id, Math.round(minutes)])), total: Math.round(totalExact) };
}

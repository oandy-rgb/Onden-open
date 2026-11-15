// The steps of a cycle run that only the lazy screens take (kept out of focusStore so the boot bundle does not
// carry them): the break begins and ends, the run closes, the next round begins. The model is focusStore's.

import { focusWriter, writeErrors } from "../data";
import { randomUUID } from "../uuid";
import { isWhole, parseFocusCycle, type FocusCycleSetting, type FocusRun } from "./focusCycle";
import { enterBreak } from "./focusCycleRules";
import { focusMinutesSpent } from "./focusText";
import { focusStore, noteEndedHere, openFocusEnding, refreshFocus, setRun } from "./focusStore";

/** Round time is up in a cycle: the record stays open (its end is fixed at the instant time was up) and the break begins. */
export function beginBreak(): void {
  const { running, run } = focusStore.get();
  if (running && run && run.phase === "focus" && run.recordId === running.id) setRun(enterBreak(run, running.started_at));
}
/** The break ran out: ask whether to go on. */
export function askAfterBreak(): void {
  const { run } = focusStore.get();
  if (run && run.phase === "break") setRun({ ...run, phase: "asking" });
}

/** 「今天到這裡」: open 「做了什麼？」 for the pending record, ended where its time was up.
 *  When that record is already ended (a next round failed to begin) there is nothing to ask: the run just closes. */
export function endRunHere(): "asking" | "closed" {
  const { run } = focusStore.get();
  if (run?.recordEnded) { setRun(null, { running: null, ending: null, expanded: false }); return "closed"; }
  openFocusEnding(run?.endedAt ?? undefined);
  return "asking";
}

/** 「開始第 N 輪」 / 「跳過休息」: end the pending record where its time was up (no sentence), then begin the next
 *  round on the same task. Two writes: if the first fails the second is not tried; if the second fails the run stays
 *  at the question (the first is not repeated). Throws what the failed write throws. */
export async function beginNextRound(): Promise<void> {
  const { running } = focusStore.get();
  let run = focusStore.get().run;
  const endedAt = run?.endedAt;
  if (!running || !run || run.phase === "focus" || !endedAt) throw new Error("no break to leave");
  if (!run.recordEnded) {
    const key = run.endKey ?? randomUUID();
    run = { ...run, endKey: key };
    try {
      await focusWriter.end(running.id, { endedAt, note: "", toDiary: false, toTask: false, attemptKey: key, fixedEnd: true });
    } catch (error) {
      // A refusal is final for this attempt; a lost answer or a dropped connection is resent under the same key.
      setRun(writeErrors.classify(error) === "rejected" ? { ...run, endKey: null } : run);
      throw error;
    }
    noteEndedHere(running.id);
    run = { ...run, recordEnded: true, endKey: null, phase: "asking", finishedMinutes: [...run.finishedMinutes, focusMinutesSpent(running.started_at, endedAt)] };
    setRun(run);
  }
  const id = run.nextId ?? randomUUID();
  setRun({ ...run, nextId: id });
  const startedAt = new Date().toISOString();
  try {
    const result = await focusWriter.start({ id, taskId: running.task_id, startedAt });
    const record = result.status === "synced" ? result.value : { id, task_id: running.task_id, started_at: startedAt, ended_at: null, note: "" };
    setRun({ ...run, recordId: id, round: run.round + 1, phase: "focus", endedAt: null, restStartedAt: null, recordEnded: false, nextId: null },
      { running: { ...record, synced: result.status === "synced" } });
  } catch (error) {
    await refreshFocus();
    throw error;
  }
}

/** A run's first round, begun with the record `recordId`. */
export function startRun(recordId: string, minutes: number, cycle: FocusCycleSetting): FocusRun {
  return { recordId, round: 1, phase: "focus", minutes, cycle, finishedMinutes: [], endedAt: null, restStartedAt: null, recordEnded: false, endKey: null, nextId: null };
}

/** A stored run read back, or null when it is not one. */
export function parseFocusRun(value: unknown): FocusRun | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const cycle = parseFocusCycle(v.cycle);
  const text = (x: unknown) => typeof x === "string" && x !== "";
  const textOrNull = (x: unknown) => x === null || text(x);
  if (!cycle || !text(v.recordId) || !isWhole(v.round, 1, 10_000) || !isWhole(v.minutes, 1, 240)) return null;
  if (v.phase !== "focus" && v.phase !== "break" && v.phase !== "asking") return null;
  if (!Array.isArray(v.finishedMinutes) || !v.finishedMinutes.every((m) => isWhole(m, 1, 240))) return null;
  if (!textOrNull(v.endedAt) || !textOrNull(v.restStartedAt) || !textOrNull(v.endKey) || !textOrNull(v.nextId) || typeof v.recordEnded !== "boolean") return null;
  if (v.phase !== "focus" && (v.endedAt === null || v.restStartedAt === null)) return null;
  return v as unknown as FocusRun;
}

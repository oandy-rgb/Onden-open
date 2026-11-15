// The rules of a focus cycle (focus → break → focus …), pure: which break follows
// round N, how much of a break is left, and what a whole run adds up to. Breaks are
// never records and never counted, so nothing here touches a record; the clock is
// read off the break's start instant, like focusRemainingMs, never a tick count.
// This file is what boot needs (the setting, a run's shape, beginning one); the rules the lazy screens
// use are in focusCycleRules.ts, so the boot bundle does not carry them.

export const MAX_REST_MINUTES = 60;
export const MAX_LONG_EVERY = 12;

/** The account's cycle choice: `rest` minutes between rounds; every `longEvery`-th
 *  round is followed by the long break instead (0: never). Null (elsewhere): no cycle. */
export type FocusCycleSetting = { rest: number; longEvery: number };

export const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** A stored or typed cycle read back, or null when it is not one. */
export function parseFocusCycle(value: unknown): FocusCycleSetting | null {
  if (typeof value !== "object" || value === null) return null;
  const { rest, longEvery } = value as Record<string, unknown>;
  return isWhole(rest, 1, MAX_REST_MINUTES) && isWhole(longEvery, 0, MAX_LONG_EVERY) ? { rest, longEvery } : null;
}

/** The run in progress on this device. One record per round: during a break the
 *  round's record is still open on the server (`recordId`), waiting to be ended at
 *  `endedAt`, the instant its time was up, so the sentence of 「做了什麼？」 can go
 *  on the last round's record. */
export type FocusRun = {
  recordId: string;
  round: number;
  /** `focus`: a round runs; `break`: the break runs; `asking`: the break is over, the person is asked. */
  phase: "focus" | "break" | "asking";
  /** The round length in minutes, and the cycle, as they were when the run began. */
  minutes: number;
  cycle: FocusCycleSetting;
  /** Real lengths of the rounds ended before this one. */
  finishedMinutes: number[];
  /** Break and asking: when time was up (the record's end) and when the break began. */
  endedAt: string | null;
  restStartedAt: string | null;
  /** True once the pending record is ended on the server (only the next round's begin is left). */
  recordEnded: boolean;
  /** Kept across resends of the same attempt (ending the pending record, beginning the next one). */
  endKey: string | null;
  nextId: string | null;
};

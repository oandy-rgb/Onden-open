// The small half of 「這次更新」 (lib/whatsNew): the change's shape and the rules
// over a list of changes. The bundled list itself (lib/whatsNew) loads on its own,
// so the boot JS holds none of the change texts.

import { getLocale } from "./i18n";

export type Change = {
  /** File name without `.md`: starts with the day, sorts oldest to newest. */
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  zh: string;
  en: string | null;
};

/** The sentence in the interface language; English falls back to the Chinese one. */
export function changeText(change: Change, locale: string = getLocale()): string {
  return locale === "zh-TW" ? change.zh : change.en ?? change.zh;
}

/** Whether `a` was made after `b` (the shape of the account's "seen up to" value). */
export const isNewerChange = (a: string, b: string): boolean => a > b;

/** The changes after `seenUpTo` (null: none seen yet), newest first. */
export function unseenChanges(changes: readonly Change[], seenUpTo: string | null): Change[] {
  return seenUpTo === null ? [...changes] : changes.filter((c) => isNewerChange(c.id, seenUpTo));
}

/** How far the account's server clock may be behind the clock that stamped the build and still count as "made with this build". */
const CLOCK_SKEW_MS = 10 * 60_000;

/** Whether an account created at `createdAtMs` (the server's clock) has seen everything in a build made at
 *  `builtAtMs` (the build machine's clock): it did not exist before the build, so no earlier list was ever its own.
 *  The two clocks are different machines: a creation within CLOCK_SKEW_MS before the build counts as after it.
 *  A skew the wrong way costs a new person a card of updates that sits over buttons; the other way costs an
 *  account made minutes before a deploy one missed update note, which the settings list still holds. */
export function createdWithThisBuild(createdAtMs: number, builtAtMs: number): boolean {
  return createdAtMs >= builtAtMs - CLOCK_SKEW_MS;
}

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
